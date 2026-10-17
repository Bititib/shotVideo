import React, { useState } from 'react';
import { mediaPreviewUrl } from '../utils/mediaPreview';

export function ImageThumbnail({ src, alt, onError, ...props }: React.ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [failedPreview, setFailedPreview] = useState('');
  const preview = mediaPreviewUrl(src, 'image');
  const usePreview = preview && failedPreview !== src;
  return <img {...props} src={usePreview ? preview : src} alt={alt} loading="lazy" decoding="async"
    onError={event => {
      if (usePreview) setFailedPreview(src);
      else onError?.(event);
    }} />;
}

/** Cards fetch only a lazy poster, never a video stream on scroll/hover.
 * The surrounding card's existing click handler opens the original player. */
export function VideoPoster({ src, className }: { src: string; className?: string }) {
  const [failed, setFailed] = useState('');
  const poster = mediaPreviewUrl(src, 'poster');
  if (!poster || failed === src) return <div className={className} aria-label="点击播放视频" />;
  return <img src={poster} className={className} alt="视频封面" loading="lazy" decoding="async" onError={() => setFailed(src)} />;
}
