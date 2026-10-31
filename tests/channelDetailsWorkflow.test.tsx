// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { adminApi } from '../client/src/api/admin';
import ChannelsPage from '../client/src/pages/admin/ChannelsPage';

vi.mock('../client/src/utils/polling', () => ({ startPolling: () => () => {} }));
vi.mock('../client/src/api/admin', () => ({ adminApi: {
  getModelSpecifications: vi.fn().mockResolvedValue([]), getChannels: vi.fn(), getSettings: vi.fn(), getModels: vi.fn(), getModelStatistics: vi.fn(),
  getPricing: vi.fn(), updatePricing: vi.fn(), syncChannelModels: vi.fn(), testChannel: vi.fn(), deleteChannel: vi.fn(),
  createChannel: vi.fn(), updateChannel: vi.fn(),
} }));
const ids = ['ZH-Cseadanco2.5K', 'ZH-Xminimex-h3', 'ZH-wan-1080', 'ZH-A-SD2.0'];
const base = { id: 9, name: '纵横渠道', type: 'zongheng', status: 1, baseUrl: 'https://example.invalid',
  apiKey: '****test', supportedModels: [] as string[], modelMapping: {}, priority: 0, weight: 1, timeout: 120000 };
let synced = false;
beforeEach(() => {
  vi.clearAllMocks(); sessionStorage.clear(); localStorage.clear(); synced = false;
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  vi.mocked(adminApi.getChannels).mockImplementation(async () => [{ ...base, supportedModels: synced ? ids : [] }]);
  vi.mocked(adminApi.getSettings).mockResolvedValue([]);
  vi.mocked(adminApi.getModels).mockImplementation(async () => synced ? ids.map((id, i) => ({
    id: i + 1, modelId: id, displayName: id, provider: 'zongheng', capabilities: ['video'], isActive: 0,
  })) : []);
  vi.mocked(adminApi.getModelStatistics).mockResolvedValue({ items: [] });
  vi.mocked(adminApi.getPricing).mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const mount = () => render(<MemoryRouter initialEntries={['/admin/channels']}><ChannelsPage /></MemoryRouter>);
const open = async () => {
  fireEvent.click(await screen.findByRole('button', { name: '查看纵横渠道详情' }));
  return screen.findByRole('dialog', { name: '纵横渠道 · 渠道详情' });
};

describe('channel details and model sync workflow', () => {
  it('edits Apipath Sunburst 1K, 2K and 4K prices inside one model', async () => {
    const id = 'gpt-image-2-5-sunburst';
    vi.mocked(adminApi.getChannels).mockResolvedValue([{ ...base, name: 'Vx-魅影', type: 'apipath', supportedModels: [id] }]);
    vi.mocked(adminApi.getModels).mockResolvedValue([{ id: 500, modelId: id, displayName: 'Sunburst', provider: 'apipath', capabilities: ['image'], isActive: 0 }]);
    vi.mocked(adminApi.getPricing).mockResolvedValue([{ id: 100, modelPattern: id, displayName: 'Sunburst', category: 'image',
      billingType: 'per_call', inputPrice: 1, outputPrice: 0, extraParams: { category: 'image' }, configured: true, modelActive: false }]);
    vi.mocked(adminApi.updatePricing).mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '查看Vx-魅影详情' }));
    fireEvent.click(await screen.findByRole('button', { name: '管理价格' }));
    const pricing = await screen.findByRole('dialog', { name: id + ' · 价格详情' });
    fireEvent.click(await within(pricing).findByRole('button', { name: '编辑', exact: true }));
    for (const [tier, price] of [['1K', '1'], ['2K', '2.5'], ['4K', '4']]) {
      fireEvent.change(await screen.findByLabelText(tier + ' 单价'), { target: { value: price } });
    }
    fireEvent.click(screen.getByRole('button', { name: '保存并立即生效' }));
    await waitFor(() => expect(adminApi.updatePricing).toHaveBeenCalledExactlyOnceWith(100, {
      modelPattern: id, billingType: 'per_call', inputPrice: 1, outputPrice: 0,
      extraParams: { category: 'image', '1K': 1, '2K': 2.5, '4K': 4 },
    }));
  });
  it('edits two Apipath keys under one channel without submitting masked or unchanged credentials', async () => {
    vi.mocked(adminApi.getChannels).mockResolvedValue([{ ...base, name: '通联', type: 'apipath', apiKey: '', apipathImageKey: '****1111', apipathVideoKey: '****2222' }]);
    vi.mocked(adminApi.updateChannel).mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '编辑通联' }));
    const image = screen.getByLabelText('图片 API Key（已配置）');
    const video = screen.getByLabelText('视频 API Key（已配置）');
    expect(image).toHaveValue(''); expect(video).toHaveValue('');
    fireEvent.change(image, { target: { value: 'new-image-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存', exact: true }));
    await waitFor(() => expect(adminApi.updateChannel).toHaveBeenCalledTimes(1));
    const [id, payload] = vi.mocked(adminApi.updateChannel).mock.calls[0];
    expect(id).toBe(base.id);
    expect(payload).toMatchObject({ type: 'apipath', apipathImageKey: 'new-image-key' });
    expect(payload).not.toHaveProperty('apiKey'); expect(payload).not.toHaveProperty('apipathVideoKey');
    expect(JSON.stringify(payload)).not.toContain('****');
  });
  it('opens HM synced nova pricing with independent resolution inputs and preserves blank fallback values', async () => {
    const id = 'sd2.5-301010';
    vi.mocked(adminApi.getChannels).mockImplementation(async () => [{ ...base, name: 'HM Studio', type: 'hmstudio',
      supportedModels: synced ? [id] : [], modelMapping: synced ? { [id]: '30-10-10' } : {} }]);
    vi.mocked(adminApi.getModels).mockImplementation(async () => synced ? [{ id: 200, modelId: id,
      displayName: id, provider: 'hmstudio', capabilities: ['video'], isActive: 0 }] : []);
    vi.mocked(adminApi.syncChannelModels).mockImplementation(async () => {
      synced = true;
      return { count: 1, added: 1, warnings: ['旧记录 30-10-10 已保留，请核对价格。'] };
    });
    vi.mocked(adminApi.getPricing).mockResolvedValue([{ id: 100, modelPattern: id, displayName: id,
      category: 'video', billingType: 'per_call', inputPrice: 9, outputPrice: 0,
      extraParams: { category: 'video' }, modelActive: false, configured: true, inherited: false }]);
    vi.mocked(adminApi.updatePricing).mockResolvedValue({});
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '同步模型' }));
    const drawer = await screen.findByRole('dialog');
    expect(await within(drawer).findByText(/旧记录 30-10-10 已保留/)).toBeVisible();
    fireEvent.click(await within(drawer).findByRole('button', { name: '管理价格' }));
    const pricingDrawer = await screen.findByRole('dialog', { name: 'sd2.5-301010 · 价格详情' });
    fireEvent.click(await within(pricingDrawer).findByRole('button', { name: '编辑', exact: true }));
    const price720 = await screen.findByLabelText('720p 单价');
    const price1080 = screen.getByLabelText('1080p 单价');
    expect(price720).toHaveValue(null);
    expect(price1080).toHaveValue(null);
    fireEvent.change(price720, { target: { value: '7' } });
    fireEvent.change(price1080, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并立即生效' }));
    await waitFor(() => expect(adminApi.updatePricing).toHaveBeenCalledExactlyOnceWith(100, {
      modelPattern: id, billingType: 'per_call', inputPrice: 9, outputPrice: 0,
      extraParams: { category: 'video', '720p': 7, '1080p': 12 },
    }));
  });
  const openDelete = async () => {
    const summary = await screen.findByLabelText('纵横渠道更多操作');
    fireEvent.click(summary);
    fireEvent.blur(summary, { relatedTarget: null });
    fireEvent.click(screen.getByRole('button', { name: '删除渠道', exact: true }));
    return screen.findByRole('dialog', { name: '删除渠道' });
  };
  it('uses an in-page confirmation and cancellation never sends a delete request', async () => {
    const native = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mount(); const dialog = await openDelete();
    expect(within(dialog).getByText('「纵横渠道」')).toBeVisible();
    expect(adminApi.deleteChannel).not.toHaveBeenCalled(); expect(native).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(adminApi.deleteChannel).not.toHaveBeenCalled();
  });
  it('sends deletion once, blocks dismissal while pending and removes the channel after success', async () => {
    let finish!: () => void;
    vi.mocked(adminApi.deleteChannel).mockImplementation(() => new Promise(resolve => {
      finish = () => { vi.mocked(adminApi.getChannels).mockResolvedValue([]); resolve({ message: '删除成功' }); };
    }));
    mount(); const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    expect(within(dialog).getByRole('button', { name: '正在删除…' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: 'Escape' }); expect(screen.getByRole('dialog')).toBeVisible();
    expect(adminApi.deleteChannel).toHaveBeenCalledExactlyOnceWith(9);
    await act(async () => finish());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('button', { name: '查看纵横渠道详情' })).toBeNull();
    expect(screen.getByText('已删除渠道「纵横渠道」')).toHaveAttribute('role', 'status');
  });
  it('keeps failed deletion and its error in the confirmation so it can be retried', async () => {
    vi.mocked(adminApi.deleteChannel).mockRejectedValueOnce(Error('无权删除此渠道')).mockResolvedValueOnce({});
    mount(); const dialog = await openDelete();
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('无权删除此渠道'));
    expect(within(dialog).getByRole('button', { name: '确认删除' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '查看纵横渠道详情' })).toBeInTheDocument();
    vi.mocked(adminApi.getChannels).mockResolvedValue([]);
    fireEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adminApi.deleteChannel).toHaveBeenCalledTimes(2);
  });
  it('keeps sync visible on the initial models tab and gives an empty channel a direct action', async () => {
    mount(); const drawer = await open();
    expect(within(drawer).getByRole('button', { name: '同步模型' })).toBeVisible();
    expect(within(drawer).getByRole('button', { name: '立即同步' })).toBeVisible();
    expect(within(drawer).getByRole('button', { name: /关联模型与价格/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(drawer).getByRole('button', { name: '配置与运行状态' }));
    expect(within(drawer).getByText('连接配置')).toBeVisible();
    expect(within(drawer).getByText('调度与运行')).toBeVisible();
    expect(within(drawer).getByRole('button', { name: '同步模型' })).toBeVisible();
    expect(within(drawer).queryByText('****test')).toBeNull();
  });
  it('syncs directly from the table, shows progress and results inside the drawer, and refreshes models', async () => {
    let finish!: () => void;
    vi.mocked(adminApi.syncChannelModels).mockImplementation(() => new Promise(resolve => {
      finish = () => { synced = true; resolve({ count: 4, added: 4 }); };
    }));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: '同步模型' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('button', { name: '正在同步…' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    await act(async () => finish());
    await waitFor(() => expect(adminApi.getModels).toHaveBeenCalled());
    expect(await within(drawer).findByText(/新增 4 个模型配置/)).toHaveTextContent('新模型默认停用');
    for (const id of ids) expect((await within(drawer).findAllByText(id))[0]).toBeVisible();
    expect(within(drawer).queryByText('还没有关联模型')).toBeNull();
    expect(adminApi.syncChannelModels).toHaveBeenCalledExactlyOnceWith(9);
  });
  it('shows a failed sync in the open drawer', async () => {
    vi.mocked(adminApi.syncChannelModels).mockRejectedValue(Error('Key 无效'));
    mount(); const drawer = await open();
    fireEvent.click(within(drawer).getByRole('button', { name: '同步模型' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toHaveTextContent('同步失败: Key 无效'));
    expect(within(drawer).getByRole('button', { name: '同步模型' })).toBeEnabled();
  });
  it('explains a zero-model response inside the drawer', async () => {
    vi.mocked(adminApi.syncChannelModels).mockResolvedValue({ count: 0, added: 0 });
    mount(); const drawer = await open();
    fireEvent.click(within(drawer).getByRole('button', { name: '立即同步' }));
    expect(await within(drawer).findByText(/上游 0 个模型/)).toHaveTextContent('模型授权');
  });
  it('reports an unsuccessful connection test as an error in the drawer', async () => {
    vi.mocked(adminApi.testChannel).mockResolvedValue({ success: false, message: '连接被拒绝' });
    mount(); const drawer = await open();
    fireEvent.click(within(drawer).getByRole('button', { name: '测试连接' }));
    await waitFor(() => expect(within(drawer).getByRole('alert')).toHaveTextContent('测试失败：连接被拒绝'));
  });
});
