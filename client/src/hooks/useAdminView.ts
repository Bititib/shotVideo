import { useEffect, useLayoutEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

function read(key: string) {
  try { return sessionStorage.getItem(key) || ''; } catch { return ''; }
}
function write(key: string, value: string) {
  try { sessionStorage.setItem(key, value); } catch { /* Storage may be unavailable. */ }
}

/** URL filters take precedence; a plain sidebar visit restores this user's last view. */
export function useAdminFilters<T extends Record<string, string>>(defaults: T, enabled = true) {
  const { pathname, search } = useLocation();
  const userId = useAuthStore(state => state.user?.id);
  const key = `admin-view:${userId}:${pathname}`;
  const [remembered] = useState(() => search ? '' : read(key));
  const [params, setParams] = useSearchParams();
  const query = search ? params.toString() : remembered;
  const effectiveParams = new URLSearchParams(query);
  const [localValues, setLocalValues] = useState(defaults);
  const values = enabled ? Object.fromEntries(Object.entries(defaults).map(([name, fallback]) =>
    [name, effectiveParams.get(name) ?? fallback])) as T : localValues;

  useEffect(() => {
    if (!enabled) return;
    write(key, query);
    if (!search && remembered) setParams(new URLSearchParams(remembered), { replace: true });
  }, [key, query, enabled, search, remembered, setParams]);
  function setFilter<K extends keyof T & string>(name: K, value: T[K]) {
    if (!enabled) { setLocalValues(previous => ({ ...previous, [name]: value })); return; }
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set(name, value);
      return next;
    }, { replace: true });
  }
  function reset() {
    if (!enabled) setLocalValues(defaults);
    else setParams(new URLSearchParams(defaults), { replace: true });
  }
  function setFilters(patch: Partial<T>) {
    if (!enabled) { setLocalValues(previous => ({ ...previous, ...patch })); return; }
    setParams(previous => {
      const next = new URLSearchParams(previous);
      for (const [name, value] of Object.entries(patch)) next.set(name, String(value));
      return next;
    }, { replace: true });
  }
  return { values, setFilter, setFilters, reset };
}

/** Restore only after the list exists, and save before route teardown changes its height. */
export function useAdminScroll(ready: boolean) {
  const { pathname } = useLocation();
  const userId = useAuthStore(state => state.user?.id);
  const key = `admin-scroll:${userId}:${pathname}`;
  useLayoutEffect(() => {
    if (!ready) return;
    const main = document.querySelector<HTMLElement>('.admin-content');
    let saved = { window: 0, main: 0 };
    try { saved = { ...saved, ...JSON.parse(read(key) || '{}') }; } catch { /* Ignore old state. */ }
    window.scrollTo(0, Number(saved.window) || 0);
    if (main) main.scrollTop = Number(saved.main) || 0;
    const save = () => write(key, JSON.stringify({ window: window.scrollY, main: main?.scrollTop || 0 }));
    window.addEventListener('scroll', save, { passive: true });
    main?.addEventListener('scroll', save, { passive: true });
    return () => {
      window.removeEventListener('scroll', save);
      main?.removeEventListener('scroll', save);
    };
  }, [key, ready]);
}
