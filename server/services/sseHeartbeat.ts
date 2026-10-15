import type { Response } from 'express';

/** Keep idle generation streams alive without reporting invented progress. */
export function startSseHeartbeat(res: Response): () => void {
  const stop = () => { clearInterval(timer); res.off?.('close', stop); res.off?.('finish', stop); };
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) { stop(); return; }
    try { res.write(': keep-alive\n\n'); } catch { stop(); }
  }, 15_000);
  timer.unref?.();
  res.once?.('close', stop);
  res.once?.('finish', stop);
  return stop;
}
