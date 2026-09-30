import { useEffect, useRef, type ReactNode } from 'react';

export default function AdminDrawer({ title, blocked, onClose, children, wide = false }: {
  title: string; blocked: boolean; onClose: () => void; children: ReactNode; wide?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => { document.body.style.overflow = overflow; previous?.focus({ preventScroll: true }); };
  }, []);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex justify-end" onMouseDown={e => {
      if (e.target === e.currentTarget && !blocked) onClose();
    }}>
      <div ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title}
        className={`h-full w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} overflow-y-auto bg-[#fffaf2] shadow-2xl`}
        onKeyDown={e => {
          if (e.key === 'Escape' && !blocked) { e.stopPropagation(); onClose(); }
          if (e.key !== 'Tab') return;
          const scope = panel.current?.querySelector('[aria-modal="true"]') || panel.current;
          const nodes = (Array.from(scope?.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') || []) as HTMLElement[]).filter(node => node.getClientRects().length);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (!first) { e.preventDefault(); return; }
          if (e.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b bg-[#fffaf2] px-5 py-4">
          <h2 className="font-semibold">{title}</h2>
          <button disabled={blocked} title={blocked ? '请先完成当前编辑或批量操作' : '关闭详情'} onClick={onClose} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}
