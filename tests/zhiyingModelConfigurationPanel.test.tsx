// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ZhiyingModelConfigurationPanel from '../client/src/components/ZhiyingModelConfigurationPanel';
import { defaultRoutingLimits } from '../shared/modelRouting';

const api = vi.hoisted(() => ({ list: vi.fn(), catalog: vi.fn(), save: vi.fn(), preview: vi.fn() }));
vi.mock('../client/src/api/admin', () => ({ adminApi: { getZhiyingModelConfigurations: api.list, getZhiyingModelCatalog: api.catalog,
  saveZhiyingModel: api.save, previewZhiyingModel: api.preview } }));
const limits = { ...defaultRoutingLimits(), defaultSeconds: 5, maxReferences: 30,
  duration: { mode: 'options' as const, min: 5, max: 10, step: 1, values: [5, 10] } };
beforeEach(() => {
  vi.resetAllMocks(); api.list.mockResolvedValue([]);
  api.catalog.mockResolvedValue({ options: [{ id: 'real-upstream', profile: { limits, promptMax: 20000 } },
    { id: 'unverified-upstream', reason: '协议未确认' }], warnings: [] });
  api.preview.mockResolvedValue({ path: '/v1/generations', body: { model: 'real-upstream' } });
  api.save.mockImplementation(async (_id, draft) => ({ ...draft, version: 'saved', editable: true }));
});
afterEach(cleanup);
it('loads the authorized catalog, fills limits, previews and saves one public/API name with an independent mapping', async () => {
  const onSaved = vi.fn(); render(<ZhiyingModelConfigurationPanel channelId={4} onClose={vi.fn()} onSaved={onSaved} />);
  await screen.findByRole('option', { name: 'real-upstream' });
  await waitFor(() => expect(screen.getByText('校验并保存').closest('fieldset')).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-Seedance2.5-3' } });
  fireEvent.change(screen.getByLabelText('智赢上游型号'), { target: { value: 'real-upstream' } });
  expect(screen.getByLabelText('默认时长')).toHaveValue(5);
  expect(screen.getByRole('option', { name: /unverified-upstream/ })).toBeDisabled();
  fireEvent.click(screen.getByText('预览上游请求'));
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith(4, expect.objectContaining({ modelId: 'Lx-Seedance2.5-3', upstreamModel: 'real-upstream', limits })));
  await screen.findByText(/以下为本地预览/);
  fireEvent.click(screen.getByText('校验并保存'));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(4, expect.objectContaining({ modelId: 'Lx-Seedance2.5-3', upstreamModel: 'real-upstream' }), null));
  await screen.findByText(/默认停用/); expect(onSaved).toHaveBeenCalledOnce();
});
it('keeps edits when a save fails and asks before discarding them', async () => {
  api.save.mockRejectedValue(new Error('授权查询期间配置已变化'));
  const close = vi.fn(); render(<ZhiyingModelConfigurationPanel channelId={4} onClose={close} onSaved={vi.fn()} />);
  await screen.findByRole('option', { name: 'real-upstream' });
  await waitFor(() => expect(screen.getByText('校验并保存').closest('fieldset')).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-New' } });
  fireEvent.change(screen.getByLabelText('智赢上游型号'), { target: { value: 'real-upstream' } });
  fireEvent.click(screen.getByText('校验并保存')); await screen.findByRole('alert');
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-New');
  fireEvent.click(screen.getByText('添加新模型')); await screen.findByRole('alertdialog');
  expect(close).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('继续编辑'));
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-New');
});

it('keeps local models and manual creation available when the upstream catalog fails', async () => {
  api.list.mockResolvedValue([{ modelId: 'Lx-Existing', upstreamModel: 'existing-upstream', limits,
    enabled: true, routeEnabled: true, editable: true, version: 'original' }]);
  api.catalog.mockRejectedValue(new Error('getaddrinfo ENOTFOUND zhiyingai.xyz'));
  api.save.mockRejectedValue(new Error('上游连接失败，未保存'));
  const onSaved = vi.fn(); render(<ZhiyingModelConfigurationPanel channelId={4} onClose={vi.fn()} onSaved={onSaved} />);
  await screen.findByText('getaddrinfo ENOTFOUND zhiyingai.xyz');
  expect(screen.getByText('1 个')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Lx-Existing/ }));
  expect(screen.getByLabelText('智赢上游 ID（手动填写）')).toHaveValue('existing-upstream');
  expect(screen.getByLabelText('默认时长')).toHaveValue(5);
  expect(screen.getByText('添加新模型')).toBeEnabled();
  fireEvent.click(screen.getByText('添加新模型'));
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-New' } });
  fireEvent.change(screen.getByLabelText('智赢上游 ID（手动填写）'), { target: { value: 'manual-upstream' } });
  fireEvent.change(screen.getByLabelText('清晰度（逗号分隔）'), { target: { value: '720p' } });
  fireEvent.change(screen.getByLabelText('比例（逗号分隔）'), { target: { value: '16:9' } });
  fireEvent.change(screen.getByLabelText('可选秒数（逗号分隔）'), { target: { value: '5,10' } });
  fireEvent.change(screen.getByLabelText('默认时长'), { target: { value: '5' } });
  fireEvent.click(screen.getByText('校验并保存'));
  await screen.findByText('上游连接失败，未保存');
  expect(api.save).toHaveBeenCalledWith(4, expect.objectContaining({ modelId: 'Lx-New', upstreamModel: 'manual-upstream',
    limits: expect.objectContaining({ resolutions: ['720p'], ratios: ['16:9'], defaultSeconds: 5, duration: expect.objectContaining({ values: [5,10] }) }) }), null);
  expect(screen.getByLabelText('智赢上游 ID（手动填写）')).toHaveValue('manual-upstream');
  expect(onSaved).not.toHaveBeenCalled();
});

it('does not block creation or closing while a catalog request is pending', async () => {
  let finish!: (value: any) => void;
  api.catalog.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const close = vi.fn(); render(<ZhiyingModelConfigurationPanel channelId={4} onClose={close} onSaved={vi.fn()} />);
  expect(screen.getByText('添加新模型')).toBeEnabled();
  expect(screen.getByRole('button', { name: '关闭' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(close).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByText('添加新模型'));
  fireEvent.click(screen.getByText('手动填写上游 ID'));
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-Pending' } });
  fireEvent.change(screen.getByLabelText('智赢上游 ID（手动填写）'), { target: { value: 'my-model' } });
  finish({ options: [], warnings: [] });
  await screen.findByText('重新读取上游目录');
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-Pending');
  expect(screen.getByLabelText('智赢上游 ID（手动填写）')).toHaveValue('my-model');
});

it('retries the upstream catalog without losing a manually entered draft', async () => {
  api.catalog.mockRejectedValueOnce(new Error('DNS failed'));
  render(<ZhiyingModelConfigurationPanel channelId={4} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByText('DNS failed');
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-Manual' } });
  fireEvent.change(screen.getByLabelText('智赢上游 ID（手动填写）'), { target: { value: 'real-upstream' } });
  fireEvent.change(screen.getByLabelText('默认时长'), { target: { value: '7' } });
  fireEvent.click(screen.getByText('重新读取上游目录'));
  await screen.findByText('填入该型号的上游参数');
  expect(screen.queryByText('DNS failed')).not.toBeInTheDocument();
  expect(screen.getByLabelText('默认时长')).toHaveValue(7);
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-Manual');
  fireEvent.click(screen.getByText('填入该型号的上游参数'));
  expect(screen.getByLabelText('默认时长')).toHaveValue(5);
  fireEvent.click(screen.getByText('校验并保存'));
  await waitFor(() => expect(api.save).toHaveBeenCalledWith(4, expect.objectContaining({ modelId: 'Lx-Manual', upstreamModel: 'real-upstream', limits }), null));
});

it('distinguishes a local configuration read failure from an empty model list and allows retry', async () => {
  api.list.mockRejectedValueOnce(new Error('本地列表读取失败'));
  render(<ZhiyingModelConfigurationPanel channelId={4} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByText('读取失败');
  expect(screen.queryByText('0 个')).not.toBeInTheDocument();
  expect(screen.getByText('添加新模型')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-Retry' } });
  fireEvent.click(screen.getByText('重试已有配置'));
  await screen.findByText('0 个');
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-Retry');
});
