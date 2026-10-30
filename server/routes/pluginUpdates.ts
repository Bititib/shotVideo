import { Router } from 'express';
import path from 'node:path';

/** Public program releases only. No credentials, user configs or upload directories. */
export function pluginUpdateRouter(directory = path.resolve('plugin-releases/video_plugin_site_api')) {
  const router = Router();
  router.get('/:name', (req, res) => {
    const name = req.params.name;
    if (name !== 'latest.json' && !/^lingxu-video-\d+\.\d+\.\d+\.zip$/.test(name)) {
      res.status(404).json({ error: 'Release not found' }); return;
    }
    res.setHeader('Cache-Control', name === 'latest.json' ? 'no-store' : 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(name, { root: directory, dotfiles: 'deny' }, error => {
      if (error && !res.headersSent) res.status(404).json({ error: 'Release not found' });
    });
  });
  return router;
}
