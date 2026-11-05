// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { MemoryRouter } from 'react-router-dom';
import { ZHIYING_VIDEO_MODELS, zhiyingVideoSpec, type ZhiyingVideoModel } from '../shared/zhiyingVideo';
import VideoStudioPage from '../client/src/pages/analysis/VideoStudioPage';

const api = vi.hoisted(() => ({ list: vi.fn(), cached: vi.fn(), generate: vi.fn() }));
vi.mock('../client/src/api/video', () => ({
  fetchVideoModels: api.list, getCachedVideoModels: api.cached, generateVideo: api.generate,
}));
vi.mock('../client/src/hooks/useAuthGuard', () => ({ useAuthGuard: () => () => true }));
vi.mock('../client/src/utils/imageNormalization', async original => ({
  ...await original<typeof import('../client/src/utils/imageNormalization')>(),
  normalizeImageFile: async (file: File) => ({ dataUrl: 'data:image/jpeg;base64,' + btoa(file.name) }),
  findUnreadableImageIndexes: async () => [],
}));

const [line1, line2] = ZHIYING_VIDEO_MODELS;
const button = (name: string | RegExp) => screen.getByRole('button', { name });
function openEditor(ids: ZhiyingVideoModel[], existingSegment = false) {
  const models = ids.map(id => ({
    id, available: true, name: zhiyingVideoSpec(id).displayName, routingLimits: zhiyingVideoSpec(id).limits,
    allowedSeconds: Array.from({ length: 26 }, (_, index) => 5 + index),
  }));
  api.cached.mockReturnValue(models);
  api.list.mockResolvedValue(models);
  const segments = existingSegment ? [{ id: 's1', prompt: '第一段', videoUrl: '/segment.mp4', model: line1, duration: 8 }] : [];
  localStorage.setItem('video_studio_projects', JSON.stringify([{
    id: 'p1', name: '分镜项目', createdAt: 1, resolution: '720p', aspectRatio: existingSegment ? '4:3' : '16:9', segments,
  }]));
  const { container } = render(<MemoryRouter><VideoStudioPage /></MemoryRouter>);
  fireEvent.click(screen.getByText('分镜项目'));
  return container;
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  api.generate.mockReturnValue(new AbortController());
});
afterEach(cleanup);

it.each(ZHIYING_VIDEO_MODELS)('submits the selected model %s at its default format and 30 seconds', async id => {
  openEditor([id]);
  expect(button('30s')).toBeVisible();
  fireEvent.click(button('16:9'));
  if (id === line2) expect(screen.queryByRole('button', { name: '4:3' })).toBeNull();
  fireEvent.click(button('21:9'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '街头的行人' } });
  fireEvent.click(button('生成'));
  await waitFor(() => expect(api.generate).toHaveBeenCalledWith(expect.objectContaining({
    model: id, video_length: 30, resolution: '720p', aspect_ratio: '21:9',
  }), expect.any(Function)));
});

it('keeps all reference images across the two lines and sends the exact selected duration', async () => {
  const container = openEditor([line1, line2]);
  const files = Array.from({ length: 10 }, (_, index) => new File(['photo'], index + '.png', { type: 'image/png' }));
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files } });
  await screen.findByRole('button', { name: /参考图 \(10\/30\)/ });
  fireEvent.click(button(zhiyingVideoSpec(line1).displayName));
  fireEvent.click(button(zhiyingVideoSpec(line2).displayName));
  expect(button(/参考图 \(10\/30\)/)).toBeVisible();
  fireEvent.click(button('30s'));
  expect(screen.queryByRole('button', { name: '4s' })).toBeNull();
  fireEvent.click(button('5s'));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '街头的行人' } });
  fireEvent.click(button('生成'));
  await waitFor(() => expect(api.generate).toHaveBeenCalled());
  const [submitted] = api.generate.mock.calls[0];
  expect(submitted).toMatchObject({ model: line2, video_length: 5 });
  expect(submitted.reference_images).toEqual(files.map(file => 'data:image/jpeg;base64,' + btoa(file.name)));
});

it('preserves the timeline format when selecting a model that does not support the project ratio', async () => {
  openEditor([line1, line2], true);
  fireEvent.click(button(zhiyingVideoSpec(line1).displayName));
  fireEvent.click(button(zhiyingVideoSpec(line2).displayName));
  expect(await screen.findByText(/所选模型不支持当前项目的 720p \/ 4:3/)).toBeVisible();
  expect(button(zhiyingVideoSpec(line1).displayName)).toBeVisible();
  expect(api.generate).not.toHaveBeenCalled();
});
