/** Completion-based polling: never overlap; pause while hidden/offline; back off on failure. */
export function startPolling(task: (signal: AbortSignal) => Promise<unknown>, interval = 5000) {
  let stopped = false, running = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const run = async () => {
    if (stopped || running) return;
    clearTimeout(timer);
    if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
    running = true;
    controller = new AbortController();
    try { await task(controller.signal); failures = 0; }
    catch { failures = Math.min(failures + 1, 4); }
    finally {
      running = false;
      if (!stopped) timer = setTimeout(run, Math.min(interval * 2 ** failures, 60000));
    }
  };
  const wake = () => { if (document.visibilityState !== 'hidden') void run(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  void run();
  return () => {
    stopped = true; clearTimeout(timer); controller?.abort();
    document.removeEventListener('visibilitychange', wake); window.removeEventListener('online', wake);
  };
}
