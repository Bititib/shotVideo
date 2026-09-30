import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';
import { loadWorkspace, saveWorkspace } from '../canvas/storage';
import { uid, type CanvasDocument, type Workspace } from '../canvas/model';
import CanvasStudio from '../canvas/CanvasStudio';
import { fetchCloudWorkspace, reconcileWorkspace, saveCloudWorkspace } from '../canvas/sync';
import './CanvasPage.css';

export default function CanvasPage() {
  const user = useAuthStore(state => state.user);
  const isLoading = useAuthStore(state => state.isLoading);
  if (isLoading) return <div className="studio-loading" role="status">正在打开创作空间…</div>;
  const owner = user ? `user-${user.id}` : 'guest';
  return <CanvasWorkspace key={owner} owner={owner} />;
}
function CanvasWorkspace({ owner }: { owner: string; key?: string }) {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('已保存到此浏览器');
  const latest = useRef<Workspace | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const version = useRef(0);
  const [retry, setRetry] = useState(0);
  const syncing = useRef(false);
  const signedIn = owner !== 'guest';
  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    if (!latest.current || (!dirty.current && !latest.current.cloudPending)) return;
    const savingVersion = version.current;
    const snapshot = latest.current;
    void saveWorkspace(owner, snapshot).then(async () => {
      if (version.current === savingVersion) {
        dirty.current = false;
        if (mounted.current) setStatus(signedIn ? '本地已保存 · 正在同步…' : '已保存到此浏览器');
      }
      if (!signedIn || syncing.current || !latest.current?.cloudPending) return;
      syncing.current = true;
      const cloudSnapshot = latest.current;
      const cloudVersion = version.current;
      try {
        const result = await saveCloudWorkspace(cloudSnapshot);
        const current = latest.current!;
        const pending = version.current !== cloudVersion;
        latest.current = { ...(pending ? current : result.workspace || current), cloudRevision: result.revision, cloudPending: pending };
        await saveWorkspace(owner, latest.current);
        if (mounted.current) { setWorkspace(latest.current); setStatus(pending ? '本地已保存 · 正在同步…' : '已同步到账户'); }
        if (pending && mounted.current) timer.current = setTimeout(flush, 600);
      } catch (error: any) {
        if (mounted.current) setStatus(`本地已保存 · ${error.message || '同步失败，请重试'}`);
      } finally { syncing.current = false; }
    }).catch(() => { if (mounted.current) setStatus('保存失败 · 请导出备份'); });
  };
  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    setError('');
    loadWorkspace(owner).then(async data => {
      if (cancelled) return;
      let message = '已保存到此浏览器';
      if (signedIn) {
        try {
          data = reconcileWorkspace(data, await fetchCloudWorkspace());
          if (cancelled) return;
          await saveWorkspace(owner, data);
          message = data.cloudPending ? '本地已保存 · 等待同步' : '已同步到账户';
        } catch { message = '本地已保存 · 云端暂不可用，点击重试'; }
      }
      if (!cancelled) { latest.current = data; setWorkspace(data); setStatus(message); if (signedIn && data.cloudPending) flush(); }
    })
      .catch(() => { if (!cancelled) setError('暂时无法读取本地画布。请允许浏览器存储后重试，原有内容不会被覆盖。'); });
    const pagehide = () => flush();
    const hidden = () => { if (document.visibilityState === 'hidden') flush(); };
    const beforeunload = (event: BeforeUnloadEvent) => { if (dirty.current) { flush(); event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('online', pagehide);
    window.addEventListener('beforeunload', beforeunload);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      cancelled = true; mounted.current = false; flush();
      window.removeEventListener('online', pagehide); window.removeEventListener('pagehide', pagehide); window.removeEventListener('beforeunload', beforeunload); document.removeEventListener('visibilitychange', hidden);
    };
  }, [owner, retry]);
  const change = (next: Workspace) => {
    next = { ...next, cloudPending: signedIn };
    latest.current = next; dirty.current = true; version.current++;
    setWorkspace(next); setStatus('正在保存…');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 600);
  };
  const update = (doc: CanvasDocument) => {
    const current = latest.current;
    if (current) change({ ...current, projects: current.projects.map(p => p.id === doc.id ? doc : p) });
  };
  if (!workspace) return <main className="studio-loading"><p role="status">{error || '正在打开创作空间…'}</p>{error && <button onClick={() => setRetry(n => n + 1)}>重新读取</button>}<a href="/">返回首页</a></main>;
  const doc = workspace.projects.find(p => p.id === workspace.activeId) ?? workspace.projects[0];
  return <CanvasStudio key={doc.id} initial={doc} projects={workspace.projects} status={status} onChange={update} onPersist={() => saveWorkspace(owner, latest.current!)} onSync={() => { if (signedIn) { latest.current = { ...latest.current!, cloudPending: true }; dirty.current = true; flush(); } }}
    onImportGuest={signedIn ? async () => {
      try {
        const guest = await loadWorkspace('guest');
        const projects = guest.projects.filter(p => p.nodes.length).map(p => ({ ...p, id: uid(), title: `${p.title}（访客导入）`, nodes: p.nodes.map(n => ({ ...n, job: undefined })) }));
        if (projects.length) change({ ...latest.current!, activeId: projects[0].id, projects: [...latest.current!.projects, ...projects] });
        else setStatus('此浏览器没有待导入的访客作品');
      } catch { setStatus('访客作品读取失败，请重试'); }
    } : undefined}
    onSwitch={id => { flush(); change({ ...latest.current!, activeId: id }); }}
    onCreate={project => { flush(); change({ ...latest.current!, activeId: project.id, projects: [...latest.current!.projects, project] }); }} />;
}
