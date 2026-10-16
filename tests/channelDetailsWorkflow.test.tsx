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
  getChannels: vi.fn(), getSettings: vi.fn(), getModels: vi.fn(), getModelStatistics: vi.fn(),
  getPricing: vi.fn(), syncChannelModels: vi.fn(), testChannel: vi.fn(), deleteChannel: vi.fn(),
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
