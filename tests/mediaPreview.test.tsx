// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mediaPreviewUrl } from '../client/src/utils/mediaPreview';
import { ImageThumbnail, VideoPoster } from '../client/src/components/MediaPreview';

afterEach(cleanup);
it('preserves signed access queries and never rewrites external or non-media URLs', () => {
  expect(mediaPreviewUrl('/api/uploads/a.png?expires=123&signature=abc', 'image')).toBe('/api/uploads/a.png?expires=123&signature=abc&preview=image');
  expect(mediaPreviewUrl('/api/media/opaque-id', 'poster')).toBe('/api/media/opaque-id?preview=poster');
  for (const source of ['https://upstream.test/a.png', 'data:image/png;base64,AA', 'blob:abc', '/api/private', '/api/media/id/link']) {
    expect(mediaPreviewUrl(source, 'image')).toBeUndefined();
  }
});
it('loads thumbnails lazily, falls back only once and reports original failures normally', () => {
  const onError = vi.fn();
  const view = render(<ImageThumbnail src="/uploads/original.png" alt="result" onError={onError} />);
  const img = screen.getByAltText('result');
  expect(img.getAttribute('src')).toBe('/uploads/original.png?preview=image');
  expect(img.getAttribute('loading')).toBe('lazy');
  fireEvent.error(img);
  expect(img.getAttribute('src')).toBe('/uploads/original.png');
  expect(onError).not.toHaveBeenCalled();
  fireEvent.error(img);
  expect(onError).toHaveBeenCalledTimes(1);
  view.rerender(<ImageThumbnail src="/uploads/next.png" alt="result" onError={onError} />);
  expect(img.getAttribute('src')).toBe('/uploads/next.png?preview=image');
});
it('renders posters instead of downloading video on hover, leaving playback to the card', () => {
  const play = vi.fn();
  const { container } = render(<button onClick={play}><VideoPoster src="/uploads/movie.mp4" /></button>);
  const poster = screen.getByAltText('视频封面');
  expect(poster.getAttribute('src')).toBe('/uploads/movie.mp4?preview=poster');
  fireEvent.mouseEnter(poster);
  expect(container.querySelector('video')).toBeNull();
  fireEvent.click(poster); expect(play).toHaveBeenCalledOnce();
  fireEvent.error(poster);
  expect(screen.getByLabelText('点击播放视频')).toBeTruthy();
  expect(container.querySelector('video')).toBeNull();
});
