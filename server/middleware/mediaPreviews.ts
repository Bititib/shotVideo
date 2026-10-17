import type { RequestHandler } from 'express';
import { createMediaPreview, resolvePreviewSource } from '../services/mediaPreviewService.js';

/** Mounted after protectUploads, before video conversion and original-file serving. */
export const mediaPreviews = (root: string, cacheRoot?: string): RequestHandler => async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method) || req.query.preview === undefined) return next();
  const kind = req.query.preview;
  if (kind !== 'image' && kind !== 'poster') {
    res.setHeader('Cache-Control', 'no-store'); res.status(400).end(); return;
  }
  try {
    const source = await resolvePreviewSource(root, req.path);
    const allowed = kind === 'image' ? /\.(png|jpe?g|webp|gif|avif|tiff?)$/i : /\.(mp4|webm|mov|mkv|m4v)$/i;
    if (!allowed.test(source)) { res.setHeader('Cache-Control', 'no-store'); res.status(415).end(); return; }
    const preview = await createMediaPreview(source, kind, cacheRoot);
    res.type(kind === 'image' ? 'image/webp' : 'image/jpeg');
    res.sendFile(preview, { cacheControl: false }, error => {
      if (error && !res.headersSent) { res.setHeader('Cache-Control', 'no-store'); res.status(404).end(); }
    });
  } catch (error: any) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(error.status === 503 ? 503 : 404).end();
  }
};
