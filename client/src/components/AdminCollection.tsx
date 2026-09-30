import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAuthStore } from '../stores/authStore';

export interface CollectionColumn<T> { title: string; render: (item: T) => ReactNode; sort?: (item: T) => string | number; }
export default function AdminCollection<T>({ name, items, id, columns, children, selected = [], onSelect, selectable = () => true }: {
  name: string; items: T[]; id: (item: T) => string; columns: CollectionColumn<T>[];
  children: (items: T[]) => ReactNode; selected?: string[]; onSelect?: (ids: string[]) => void; selectable?: (item: T) => boolean;
}) {
  const user = useAuthStore(state => state.user?.id);
  const key = `collection:${user}:${name}`;
  const [view, setView] = useState(() => { try { return JSON.parse(sessionStorage.getItem(key) || '{}'); } catch { return {}; } });
  const [top, setTop] = useState(Number(view.top) || 0);
  const viewport = useRef<HTMLDivElement>(null);
  const mode = view.mode === 'cards' ? 'cards' : 'table';
  useLayoutEffect(() => { if (viewport.current) viewport.current.scrollTop = Number(view.top) || 0; }, [mode]);
  const sort = columns[view.sort || 0]?.sort;
  const sorted = useMemo(() => [...items].sort((a, b) => {
    if (!sort) return 0;
    const x = sort(a), y = sort(b);
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'zh-CN', { numeric: true })) * (view.desc ? -1 : 1);
  }), [items, sort, view.desc]);
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(view)); } catch {} }, [key, view]);
  const pages = Math.max(1, Math.ceil(sorted.length / 24));
  const page = Math.min(Math.max(1, Number(view.page) || 1), pages);
  const start = Math.max(0, Math.min(Math.floor(top / 64) - 4, Math.max(0, sorted.length - 14)));
  const visible = sorted.slice(start, start + 18);
  const candidates = items.filter(selectable).map(id);
  const toggle = (item: T) => onSelect?.(selected.includes(id(item)) ? selected.filter(key => key !== id(item)) : [...selected, id(item)]);
  const updateView = (patch: any) => { setView((old: any) => ({ ...old, top: 0, ...patch })); setTop(0); if (viewport.current) viewport.current.scrollTop = 0; };
  return <section className="admin-collection">
    <div className="admin-list-tools flex flex-wrap items-center gap-3 rounded-xl border p-3 mb-3">
      <span className="text-xs">共 {items.length} 条</span>
      <button aria-pressed={mode === 'table'} onClick={() => updateView({ mode: 'table' })}>表格</button>
      <button aria-pressed={mode === 'cards'} onClick={() => updateView({ mode: 'cards' })}>卡片</button>
      <select aria-label="排序字段" value={view.sort || 0} onChange={e => updateView({ sort: Number(e.target.value) })}>{columns.map((column, index) => column.sort && <option key={index} value={index}>{column.title}</option>)}</select>
      <button onClick={() => updateView({ desc: !view.desc })}>{view.desc ? '降序' : '升序'}</button>
      {onSelect && <><button onClick={() => onSelect(candidates)}>选择筛选结果（{candidates.length}）</button><button onClick={() => onSelect([])}>清空选择</button><span className="text-xs">已选 {selected.length}</span></>}
    </div>
    {mode === 'table' ? <div ref={viewport} className="admin-table-viewport overflow-auto rounded-xl border" style={{ maxHeight: 560 }} onScroll={e => { const next = e.currentTarget.scrollTop; setTop(next); setView((old: any) => ({ ...old, top: next })); }}>
      <table className="w-full text-sm border-collapse" style={{ minWidth: 720, tableLayout: 'fixed' }} aria-label={name} aria-rowcount={items.length + 1}>
        <thead className="sticky top-0 z-10 bg-[#fffaf2]"><tr>{onSelect && <th className="w-12 p-3">选择</th>}{columns.map((column, index) => <th key={index} className="p-3 text-left border-b">{column.title}</th>)}</tr></thead>
        <tbody>
          {start > 0 && <tr aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: start * 64, padding: 0 }} /></tr>}
          {visible.map((item, index) => <tr key={id(item)} aria-rowindex={start + index + 2} className="border-b" style={{ height: 64 }}>
            {onSelect && <td className="p-3"><input type="checkbox" aria-label={`选择 ${id(item)}`} disabled={!selectable(item)} checked={selected.includes(id(item))} onChange={() => toggle(item)} /></td>}
            {columns.map((column, columnIndex) => <td key={columnIndex} className="px-3"><div className="overflow-hidden" style={{ maxHeight: 60 }}>{column.render(item)}</div></td>)}
          </tr>)}
          {start + visible.length < sorted.length && <tr aria-hidden="true"><td colSpan={columns.length + 1} style={{ height: (sorted.length - start - visible.length) * 64, padding: 0 }} /></tr>}
        </tbody>
      </table>
    </div> : <>{children(sorted.slice((page - 1) * 24, page * 24))}<div className="flex items-center justify-center gap-4 p-4"><button disabled={page === 1} onClick={() => updateView({ page: page - 1 })}>上一页</button><span>{page} / {pages}</span><button disabled={page === pages} onClick={() => updateView({ page: page + 1 })}>下一页</button></div></>}
  </section>;
}
