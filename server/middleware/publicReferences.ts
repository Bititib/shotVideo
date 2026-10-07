import express from 'express';
import { publicReferenceRoot } from '../services/publicReferenceService.js';

/** Read-only public delivery; no directory listing, arbitrary paths or writes. */
export const publicReferences = () => {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) { res.status(405).end(); return; }
    if (!/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.(png|jpg|gif|webp|avif|mp4|mov|webm|m4a|mp3|wav|ogg|aac)$/.test(req.path)) {
      res.status(404).end(); return;
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  });
  router.use(express.static(publicReferenceRoot(), { index: false, redirect: false, maxAge: '1d', immutable: true }));
  router.use((_req, res) => { res.status(404).end(); });
  return router;
};
