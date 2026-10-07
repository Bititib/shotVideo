import type { RequestHandler } from 'express';
import { resolveBatchArchiveFile } from '../services/videoBatchArchive.js';
import { prepareVideoForDelivery, videoDeliveryContentType } from '../services/videoCompatibilityService.js';

/** Must run AFTER upload authorization. Old signed/owned URLs remain valid,
 * preferring H.264 while retaining usable originals when conversion fails. */
export const h264Uploads = (root: string): RequestHandler => async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method)) return next();
  let pathname: string;
  try { pathname = decodeURIComponent(req.path); } catch { res.status(400).end(); return; }
  if (!/\.(mp4|webm|mov|mkv|m4v)$/i.test(pathname)) return next();
  try {
    const file = resolveBatchArchiveFile('/uploads' + req.path, root);
    const compatible = await prepareVideoForDelivery(file);
    res.type(videoDeliveryContentType(compatible));
    res.sendFile(compatible, { cacheControl: false });
  } catch (error: any) {
    if (error.code === 'ENOENT') { res.status(404).end(); return; }
    console.warn('[uploads] H.264 preparation failed:', error.message);
    res.status(502).json({ error: 'H.264 视频准备失败，请稍后重试' });
  }
};
