import { useEffect, useRef, useState, type SetStateAction } from 'react';
import { useAuthStore } from '../stores/authStore';

// Drafts are session-only and never persist API credentials.
function sanitize(value: any): any {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(apiKey|password|secret|token)$/i.test(key) ? '' : sanitize(item)]));
}
export function useEditDraft(name: string, busy: boolean) {
  const user = useAuthStore(state => state.user?.id);
  const key = `edit-draft:${user}:${name}`;
  const [edit, update] = useState<any>(null);
  const baseline = useRef('');
  const dirty = edit !== null && JSON.stringify(edit) !== baseline.current;
  const [available, setAvailable] = useState(() => { try { return !!sessionStorage.getItem(key); } catch { return false; } });
  const setEdit = (value: SetStateAction<any>) => {
    if (value === null) {
      try { sessionStorage.removeItem(key); } catch {}
      setAvailable(false); baseline.current = ''; update(null); return;
    }
    if (edit === null && typeof value !== 'function') baseline.current = JSON.stringify(value);
    update(value);
  };
  useEffect(() => {
    if (!dirty) return;
    try { sessionStorage.setItem(key, JSON.stringify({ value: sanitize(edit), savedAt: Date.now() })); setAvailable(true); } catch {}
  }, [edit, dirty, key]);
  useEffect(() => {
    if (!dirty && !busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const click = (event: MouseEvent) => {
      const link = (event.target as HTMLElement)?.closest('a[href]');
      if (!link || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (busy || !window.confirm('有未保存的修改，确定离开？草稿将保留以便恢复。')) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', click, true);
    return () => { window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('click', click, true); };
  }, [dirty, busy]);
  const close = () => { if (!busy && (!dirty || window.confirm('放弃当前未保存的修改？'))) setEdit(null); };
  const restore = () => {
    try {
      const draft = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (draft?.value && Date.now() - draft.savedAt < 86400000) { baseline.current = ''; update(draft.value); }
      else { sessionStorage.removeItem(key); setAvailable(false); }
    } catch { setAvailable(false); }
  };
  return { edit, setEdit, close, restore, available, dirty };
}
