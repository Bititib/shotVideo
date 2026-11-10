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
  await waitFor(() => expect(screen.getByText('校验并保存').closest('fieldset')).not.toBeDisabled());
  fireEvent.change(screen.getByLabelText('本站名称 / API 模型 ID'), { target: { value: 'Lx-New' } });
  fireEvent.change(screen.getByLabelText('智赢上游型号'), { target: { value: 'real-upstream' } });
  fireEvent.click(screen.getByText('校验并保存')); await screen.findByRole('alert');
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-New');
  fireEvent.click(screen.getByText('添加新模型')); await screen.findByRole('alertdialog');
  expect(close).not.toHaveBeenCalled(); fireEvent.click(screen.getByText('继续编辑'));
  expect(screen.getByLabelText('本站名称 / API 模型 ID')).toHaveValue('Lx-New');
});
