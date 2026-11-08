// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultRoutingLimits } from '../shared/modelRouting';
import type { V6kModelConfiguration } from '../shared/v6kModelConfiguration';
import V6kModelConfigurationPanel from '../client/src/components/V6kModelConfigurationPanel';

const api = vi.hoisted(() => ({ list: vi.fn(), preview: vi.fn(), save: vi.fn() }));
vi.mock('../client/src/api/admin', () => ({ adminApi: {
  getV6kModelConfigurations: api.list, previewV6kModel: api.preview, saveV6kModel: api.save,
} }));

const configuration = (): V6kModelConfiguration => ({ modelId: 'public-video', displayName: '原名称',
  upstreamModel: 'old-provider-model', editable: true, version: 'version-one',
  enabled: true, routeEnabled: true,
  limits: { ...defaultRoutingLimits(), maxImages: 30, maxVideos: 10, maxAudios: 10, defaultSeconds: 10,
    duration: { mode: 'options', min: 5, max: 15, step: 1, values: [5, 10, 15] } },
});

beforeEach(() => {
  vi.resetAllMocks();
  api.list.mockResolvedValue([configuration()]);
  api.preview.mockResolvedValue({ method: 'POST', path: '/v1/videos', body: { model: 'new-provider-model', seconds: 10, resolution: '1080p' } });
  api.save.mockImplementation(async (_id, draft) => {
    const saved = { ...draft, editable: true, version: 'version-two' };
    api.list.mockResolvedValue([saved]);
    return saved;
  });
});
afterEach(cleanup);

it('keeps the public ID read-only, previews the unsaved draft and saves it with the original version', async () => {
  const onSaved = vi.fn();
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={onSaved} />);
  const id = await screen.findByLabelText('本站 API 模型 ID');
  await waitFor(() => expect(id).toHaveValue('public-video'));
  expect(id).toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '新名称' } });
  fireEvent.change(screen.getByLabelText('上游模型 ID'), { target: { value: 'new-provider-model' } });
  fireEvent.change(screen.getByLabelText('可选分辨率'), { target: { value: '1080p' } });
  fireEvent.click(screen.getByRole('button', { name: '请求体样例' }));
  fireEvent.change(screen.getByLabelText('示例视频数量'), { target: { value: '1' } });
  fireEvent.click(screen.getByRole('button', { name: '预览实际请求体' }));
  await screen.findByText('/v1/videos');
  expect(screen.getByText('POST')).toBeVisible();
  expect(api.preview).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'public-video', upstreamModel: 'new-provider-model',
    limits: expect.objectContaining({ resolutions: ['1080p'], maxVideos: 10 }) }), { videos: 1 });
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存修改' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.save).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'public-video', displayName: '新名称' }), 'version-one');
  expect(screen.getByRole('status')).toHaveTextContent('配置已保存');
});

it('starts a new entry with an editable ID and preserves unsaved values when the server rejects authorization', async () => {
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.click(screen.getByRole('button', { name: '添加新模型' }));
  const id = screen.getByLabelText('本站 API 模型 ID');
  expect(id).not.toHaveAttribute('readonly');
  fireEvent.change(id, { target: { value: 'new-public' } });
  fireEvent.change(screen.getByLabelText('上游模型 ID'), { target: { value: 'new-provider-model' } });
  api.save.mockRejectedValue(new Error('当前渠道 Key 的模型列表未返回该上游 ID'));
  fireEvent.click(screen.getByRole('button', { name: '校验授权并添加模型' }));
  await screen.findByRole('alert');
  expect(id).toHaveValue('new-public');
  expect(api.save).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'new-public' }), null);
});

it('shows why a dedicated multi-route entry uses its existing management controls', async () => {
  api.list.mockResolvedValue([{ ...configuration(), editable: false, reason: '此入口由专用分流或来源设置管理' }]);
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByText('此入口由专用分流或来源设置管理');
  expect(screen.getByRole('button', { name: '校验授权并保存修改' })).toBeDisabled();
  expect(api.save).not.toHaveBeenCalled();
});

it('finds an existing model by its upstream ID and switches the editor without saving or previewing', async () => {
  const second = { ...configuration(), modelId: 'other-video', displayName: '第二个模型', upstreamModel: 'upstream-second', version: 'other-one' };
  api.list.mockResolvedValue([configuration(), second]);
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.change(screen.getByLabelText('搜索已有模型'), { target: { value: 'upstream-second' } });
  expect(screen.queryByRole('button', { name: '编辑模型 原名称' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '编辑模型 第二个模型' }));
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('other-video');
  expect(screen.getByLabelText('上游模型 ID')).toHaveValue('upstream-second');
  expect(screen.getByRole('button', { name: '编辑模型 第二个模型' })).toHaveAttribute('aria-current', 'true');
  expect(api.save).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
});

it('separates adding from editing and preserves unsaved input until navigation is explicitly chosen', async () => {
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.click(screen.getByRole('button', { name: '添加新模型' }));
  expect(screen.getByRole('list', { name: '添加模型步骤' })).toBeInTheDocument();
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('');
  expect(screen.getByLabelText('上游模型 ID')).toHaveValue('');
  expect(screen.getByRole('button', { name: '校验授权并添加模型' })).toBeEnabled();
  fireEvent.change(screen.getByLabelText('本站 API 模型 ID'), { target: { value: 'new-entry' } });
  fireEvent.click(screen.getByRole('button', { name: '编辑模型 原名称' }));
  expect(screen.getByRole('alert')).toHaveTextContent('当前修改尚未保存');
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('new-entry');
  fireEvent.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('new-entry');
  fireEvent.click(screen.getByRole('button', { name: '编辑模型 原名称' }));
  fireEvent.click(screen.getByRole('button', { name: '放弃修改并切换' }));
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video');
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveAttribute('readonly');
  expect(api.save).not.toHaveBeenCalled();
});

it('refreshes every model version after saving so the next model uses its current channel version', async () => {
  const second = { ...configuration(), modelId: 'second', displayName: '第二个模型', version: 'second-before' };
  api.list.mockResolvedValue([configuration(), second]);
  api.save.mockImplementation(async (_channel, draft) => {
    const saved = { ...draft, editable: true, version: 'saved-current' };
    api.list.mockResolvedValue([saved, { ...second, version: 'second-after' }]);
    return saved;
  });
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '修改后的名称' } });
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存修改' }));
  await screen.findByText('配置已保存。后续提交使用新配置。');
  fireEvent.click(screen.getByRole('button', { name: '编辑模型 第二个模型' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存修改' }));
  await waitFor(() => expect(api.save).toHaveBeenCalledTimes(2));
  expect(api.save).toHaveBeenLastCalledWith(21, expect.objectContaining({ modelId: 'second' }), 'second-after');
});

it('does not report a successful save as failed when the following list refresh fails', async () => {
  api.save.mockImplementation(async (_channel, draft) => {
    api.list.mockRejectedValue(new Error('列表暂时不可用'));
    return { ...draft, editable: true, version: 'saved-current' };
  });
  const onSaved = vi.fn();
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '已保存名称' } });
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存修改' }));
  await screen.findByRole('status');
  expect(screen.getByRole('status')).toHaveTextContent('配置已保存');
  expect(screen.getByRole('status')).toHaveTextContent('模型列表刷新失败');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByLabelText('显示名称')).toHaveValue('已保存名称');
  expect(onSaved).toHaveBeenCalledOnce();
  expect(api.save).toHaveBeenCalledOnce();
});

it('adds one model with a null version, selects the returned entry and explains the remaining price and activation step', async () => {
  const original = configuration();
  api.save.mockImplementation(async (_channel, draft) => {
    const saved = { ...draft, editable: true, version: 'new-version' };
    api.list.mockResolvedValue([original, saved]);
    return saved;
  });
  const onSaved = vi.fn();
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={onSaved} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.click(screen.getByRole('button', { name: '添加新模型' }));
  fireEvent.change(screen.getByLabelText('本站 API 模型 ID'), { target: { value: 'my-video' } });
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '我的新模型' } });
  fireEvent.change(screen.getByLabelText('上游模型 ID'), { target: { value: 'provider-video' } });
  fireEvent.click(screen.getByRole('button', { name: '校验授权并添加模型' }));
  await screen.findByRole('status');
  expect(screen.getByRole('status')).toHaveTextContent('模型已添加，模型总开关保持停用');
  expect(screen.getByRole('status')).toHaveTextContent('设置售价并启用');
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveAttribute('readonly');
  expect(screen.getByRole('button', { name: '编辑模型 我的新模型' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('button', { name: '编辑模型 原名称' })).toBeInTheDocument();
  expect(api.save).toHaveBeenCalledExactlyOnceWith(21, expect.objectContaining({ modelId: 'my-video', upstreamModel: 'provider-video' }), null);
  expect(onSaved).toHaveBeenCalledOnce();
  expect(api.preview).not.toHaveBeenCalled();
});

it('warns before closing a dirty draft but still permits closing after a load error', async () => {
  const onClose = vi.fn();
  const view = render(<V6kModelConfigurationPanel channelId={21} onClose={onClose} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '未保存名称' } });
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '放弃修改并关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  onClose.mockClear();
  api.list.mockRejectedValue(new Error('读取失败'));
  render(<V6kModelConfigurationPanel channelId={21} onClose={onClose} onSaved={vi.fn()} />);
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(api.save).not.toHaveBeenCalled();
});

it('uses the compact model selector without dropping a dirty draft or saving on selection', async () => {
  const second = { ...configuration(), modelId: 'second', displayName: '第二个模型', upstreamModel: 'second-provider' };
  api.list.mockResolvedValue([configuration(), second]);
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  const picker = screen.getByRole('combobox', { name: '切换模型', exact: true });
  fireEvent.change(picker, { target: { value: 'second' } });
  expect(screen.getByLabelText('上游模型 ID')).toHaveValue('second-provider');
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: '暂未保存' } });
  fireEvent.change(picker, { target: { value: 'public-video' } });
  expect(screen.getByRole('alert')).toHaveTextContent('当前修改尚未保存');
  expect(picker).toHaveValue('second');
  expect(screen.getByLabelText('显示名称')).toHaveValue('暂未保存');
  fireEvent.click(screen.getByRole('button', { name: '放弃修改并切换' }));
  expect(picker).toHaveValue('public-video');
  expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video');
  expect(api.save).not.toHaveBeenCalled();
  expect(api.preview).not.toHaveBeenCalled();
});
