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
  api.save.mockImplementation(async (_id, draft) => ({ ...draft, editable: true, version: 'version-two' }));
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
  await screen.findByText('POST /v1/videos');
  expect(api.preview).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'public-video', upstreamModel: 'new-provider-model',
    limits: expect.objectContaining({ resolutions: ['1080p'], maxVideos: 10 }) }), { videos: 1 });
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
  expect(api.save).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'public-video', displayName: '新名称' }), 'version-one');
  expect(screen.getByRole('status')).toHaveTextContent('配置已保存');
});

it('starts a new entry with an editable ID and preserves unsaved values when the server rejects authorization', async () => {
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await waitFor(() => expect(screen.getByLabelText('本站 API 模型 ID')).toHaveValue('public-video'));
  fireEvent.click(screen.getByRole('button', { name: '添加模型' }));
  const id = screen.getByLabelText('本站 API 模型 ID');
  expect(id).not.toHaveAttribute('readonly');
  fireEvent.change(id, { target: { value: 'new-public' } });
  fireEvent.change(screen.getByLabelText('上游模型 ID'), { target: { value: 'new-provider-model' } });
  api.save.mockRejectedValue(new Error('当前渠道 Key 的模型列表未返回该上游 ID'));
  fireEvent.click(screen.getByRole('button', { name: '校验授权并保存' }));
  await screen.findByRole('alert');
  expect(id).toHaveValue('new-public');
  expect(api.save).toHaveBeenCalledWith(21, expect.objectContaining({ modelId: 'new-public' }), null);
});

it('shows why a dedicated multi-route entry uses its existing management controls', async () => {
  api.list.mockResolvedValue([{ ...configuration(), editable: false, reason: '此入口由专用分流或来源设置管理' }]);
  render(<V6kModelConfigurationPanel channelId={21} onClose={vi.fn()} onSaved={vi.fn()} />);
  await screen.findByText('此入口由专用分流或来源设置管理');
  expect(screen.getByRole('button', { name: '校验授权并保存' })).toBeDisabled();
  expect(api.save).not.toHaveBeenCalled();
});
