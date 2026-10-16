// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UserModelSettings from '../client/src/components/UserModelSettings';
import { adminApi } from '../client/src/api/admin';
import type { UserModelSetting } from '../shared/userModelSettings';
vi.mock('../client/src/api/admin', () => ({ adminApi: { getUserModels: vi.fn(), updateUserModels: vi.fn() } }));
const item: UserModelSetting = { id: 20, modelId: 'test-video', displayName: '测试视频', kind: 'video', active: true, accessMode: 'inherit',
  pricingMode: 'inherit', defaultPrice: { billingType: 'per_second', inputPrice: .5, outputPrice: 0, extraParams: { '720p': .6, '1080p': .8 } },
  customPrice: null, effectivePrice: { billingType: 'per_second', inputPrice: .5, outputPrice: 0, extraParams: { '720p': .6, '1080p': .8 } }, resolutions: ['720p', '1080p'] };
const image: UserModelSetting = { ...item, id: 21, modelId: 'test-image', displayName: '测试图片', kind: 'image', resolutions: [],
  defaultPrice: { billingType: 'per_call', inputPrice: .4, outputPrice: 0, extraParams: {} } };
const renderEditor = () => render(<UserModelSettings user={{ id: 1, username: '示例用户', email: '1@test.invalid' }} onClose={vi.fn()}/>);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(adminApi.getUserModels).mockResolvedValue([item, image]);
  vi.mocked(adminApi.updateUserModels).mockImplementation(async (_id, changes) => changes.map(change => ({
    ...(change.modelId === item.id ? item : image), accessMode: change.accessMode, pricingMode: change.pricingMode,
    customPrice: change.customPrice ? { ...change.customPrice, revision: 1 } : null,
  })));
});
afterEach(cleanup);

describe('compact user model price table', () => {
  it('edits multiple inline prices and separate permissions with one save, including free prices', async () => {
    renderEditor();
    expect(screen.getByText('示例用户')).toBeTruthy();
    expect(screen.getByText('1@test.invalid')).toBeTruthy();
    expect(screen.getByText('用户 #1')).toBeTruthy();
    fireEvent.change(await screen.findByLabelText('测试视频 独立价格'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('测试图片 独立价格'), { target: { value: '.2' } });
    fireEvent.click(screen.getByRole('tab', { name: '模型权限' }));
    fireEvent.change(screen.getByLabelText('测试视频 模型权限'), { target: { value: 'allow' } });
    fireEvent.click(screen.getByRole('tab', { name: '独立价格' }));
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [
      { modelId: 20, accessMode: 'allow', pricingMode: 'custom', expectedRevision: null, customPrice: { billingType: 'per_second', inputPrice: 0, outputPrice: 0, extraParams: {} } },
      { modelId: 21, accessMode: 'inherit', pricingMode: 'custom', expectedRevision: null, customPrice: { billingType: 'per_call', inputPrice: .2, outputPrice: 0, extraParams: {} } },
    ]));
    expect(await screen.findByRole('status')).toHaveProperty('textContent', '已保存 2 个模型的设置');
    expect(screen.getByRole('button', { name: '保存价格' })).toHaveProperty('disabled', true);
  });
  it('restores default prices while retaining an independent deny permission', async () => {
    vi.mocked(adminApi.getUserModels).mockResolvedValue([{ ...item, accessMode: 'deny', pricingMode: 'custom', customPrice: { ...item.defaultPrice!, revision: 4 } }]);
    renderEditor();
    fireEvent.click(await screen.findByRole('button', { name: '测试视频 恢复默认价格' }));
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [
      { modelId: 20, accessMode: 'deny', pricingMode: 'inherit', customPrice: undefined, expectedRevision: 4 },
    ]));
  });
  it('preserves resolution prices when changing only model access', async () => {
    vi.mocked(adminApi.getUserModels).mockResolvedValue([{ ...item, pricingMode: 'custom', customPrice: { ...item.defaultPrice!, inputPrice: .3, extraParams: { '720p': .35 }, revision: 4 } }]);
    renderEditor(); await screen.findByLabelText('测试视频 独立价格');
    fireEvent.click(screen.getByRole('tab', { name: '模型权限' }));
    fireEvent.change(screen.getByLabelText('测试视频 模型权限'), { target: { value: 'deny' } });
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [expect.objectContaining({ accessMode: 'deny', expectedRevision: 4,
      customPrice: { billingType: 'per_second', inputPrice: .3, outputPrice: 0, extraParams: { '720p': .35 } } })]));
  });
  it('uses a new uniform price for all resolutions when editing the main input', async () => {
    vi.mocked(adminApi.getUserModels).mockResolvedValue([{ ...item, pricingMode: 'custom', customPrice: { ...item.defaultPrice!, revision: 4 } }]);
    renderEditor(); fireEvent.change(await screen.findByLabelText('测试视频 独立价格'), { target: { value: '.3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [expect.objectContaining({ customPrice: { billingType: 'per_second', inputPrice: .3, outputPrice: 0, extraParams: {} } })]));
  });
  it('expands resolution settings without changing prices, then preserves unedited resolutions', async () => {
    renderEditor(); fireEvent.click(await screen.findByRole('button', { name: '测试视频 分辨率价格' }));
    expect(screen.getByRole('button', { name: '保存价格' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('测试视频 720p 独立价格'), { target: { value: '.2' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [expect.objectContaining({ customPrice: { billingType: 'per_second', inputPrice: .5, outputPrice: 0, extraParams: { '720p': .2, '1080p': .8 } } })]));
  });
  it('retains edits across search, type filtering and pagination', async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...item, id: index + 1, modelId: 'video-' + index, displayName: '视频' + index }));
    vi.mocked(adminApi.getUserModels).mockResolvedValue(many);
    renderEditor(); fireEvent.change(await screen.findByLabelText('视频0 独立价格'), { target: { value: '.1' } });
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    fireEvent.change(await screen.findByLabelText('视频10 独立价格'), { target: { value: '.2' } });
    fireEvent.change(screen.getByLabelText('搜索模型'), { target: { value: 'video-0' } });
    expect(await screen.findByLabelText('视频0 独立价格')).toHaveProperty('valueAsNumber', .1);
    fireEvent.change(screen.getByLabelText('模型类型'), { target: { value: 'image' } });
    expect(await screen.findByText('没有符合条件的模型')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [expect.objectContaining({ modelId: 1 }), expect.objectContaining({ modelId: 11 })]));
  });
  it('filters by draft independent prices including zero', async () => {
    renderEditor(); fireEvent.change(await screen.findByLabelText('测试视频 独立价格'), { target: { value: '0' } });
    fireEvent.click(screen.getByLabelText('仅看独立价格'));
    expect(screen.queryByLabelText('测试图片 独立价格')).toBeNull();
    expect(screen.getByLabelText('测试视频 独立价格')).toHaveProperty('value', '0');
  });
  it('keeps drafts available when the atomic save fails', async () => {
    vi.mocked(adminApi.updateUserModels).mockRejectedValue(new Error('其他管理员已修改该价格'));
    renderEditor(); fireEvent.change(await screen.findByLabelText('测试视频 独立价格'), { target: { value: '.3' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '其他管理员已修改该价格');
    expect(screen.getByLabelText('测试视频 独立价格')).toHaveProperty('valueAsNumber', .3);
    expect(screen.getByRole('button', { name: '保存价格' })).toHaveProperty('disabled', false);
  });
  it('supports separate token input and output prices in the table', async () => {
    vi.mocked(adminApi.getUserModels).mockResolvedValue([{ ...item, kind: 'text', resolutions: [], defaultPrice: { billingType: 'per_token', inputPrice: 3, outputPrice: 8, extraParams: {} } }]);
    renderEditor(); await screen.findByLabelText('测试视频 独立价格');
    fireEvent.change(screen.getByLabelText('测试视频 输出独立价格'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存价格' }));
    await waitFor(() => expect(adminApi.updateUserModels).toHaveBeenCalledWith(1, [expect.objectContaining({ customPrice: { billingType: 'per_token', inputPrice: 3, outputPrice: 0, extraParams: {} } })]));
  });
});
