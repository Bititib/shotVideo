import type Database from 'better-sqlite3';
import { FUND_ACCOUNTS, FUND_KINDS, type FundEntry, type FundTask } from '../../shared/fundLedger.js';
import { beijingDayBounds, beijingDateKey } from '../../shared/time.js';

export function listFundLedger(db: Database.Database, query: Record<string, unknown>) {
  const bad = (): never => { throw Object.assign(new Error('流水筛选参数无效'), { status: 400 }); };
  const integer = (value: unknown, fallback: number, max: number) => {
    if (value === undefined || value === '') return fallback;
    if (typeof value !== 'string' && typeof value !== 'number') return bad();
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1 || n > max) return bad();
    return n;
  };
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const hasContents = hasTable('contents'), hasLinks = hasTable('fund_ledger_content_links');
  const owner = hasContents ? 'COALESCE(l.user_id,c.user_id)' : 'l.user_id';
  const from = ' FROM fund_ledger l LEFT JOIN users u ON u.id=l.actor_id'
    + (hasContents ? ' LEFT JOIN contents c ON c.id=l.content_id' : '')
    + ' LEFT JOIN users owner ON owner.id=' + owner;
  const page = integer(query.page, 1, 1000000), pageSize = integer(query.pageSize, 30, 100);
  const conditions: string[] = [], params: any[] = [];
  const scopes: Record<string, string> = { all: '', wallet: "l.account_type IN ('user','org')", quota: "l.account_type='token'", usage: "l.account_type='token_usage'" };
  const scope = query.scope === undefined || query.scope === '' ? 'all' : query.scope;
  if (typeof scope !== 'string' || !Object.hasOwn(scopes, scope)) bad();
  if (scopes[scope as string]) conditions.push(scopes[scope as string]);
  for (const [key, column, allowed] of [['accountType', 'account_type', FUND_ACCOUNTS], ['kind', 'kind', FUND_KINDS]] as const) {
    if (query[key]) {
      if (typeof query[key] !== 'string' || !Object.hasOwn(allowed, query[key] as string)) bad();
      conditions.push('l.' + column + '=?'); params.push(query[key]);
    }
  }
  if (query.accountId) { conditions.push('l.account_id=?'); params.push(integer(query.accountId, 0, Number.MAX_SAFE_INTEGER)); }
  if (query.userId !== undefined && query.userId !== '') {
    const id = integer(query.userId, 0, Number.MAX_SAFE_INTEGER);
    if (hasContents && hasLinks) {
      conditions.push('(' + owner + '=? OR EXISTS(SELECT 1 FROM fund_ledger_content_links fl JOIN contents ct ON ct.id=fl.content_id WHERE fl.entry_id=l.id AND ct.user_id=?))');
      params.push(id, id);
    } else { conditions.push(owner + '=?'); params.push(id); }
  }
  if (query.contentId !== undefined && query.contentId !== '') {
    const id = integer(query.contentId, 0, Number.MAX_SAFE_INTEGER);
    conditions.push(hasLinks ? '(l.content_id=? OR EXISTS(SELECT 1 FROM fund_ledger_content_links fl WHERE fl.entry_id=l.id AND fl.content_id=?))' : 'l.content_id=?');
    params.push(id); if (hasLinks) params.push(id);
  }
  if (query.search) {
    if (typeof query.search !== 'string' || query.search.length > 100) bad();
    conditions.push('instr(l.account_name,?)>0'); params.push(query.search);
  }
  for (const key of ['from', 'to']) if (query[key]) {
    if (typeof query[key] !== 'string') bad();
    const day = query[key] as string, bounds = beijingDayBounds(day);
    if (!bounds || beijingDateKey(new Date(day + 'T00:00:00+08:00')) !== day) bad();
    conditions.push('l.created_at' + (key === 'from' ? '>=?' : '<?'));
    params.push(key === 'from' ? bounds!.start : bounds!.end);
  }
  if (query.from && query.to && String(query.from) > String(query.to)) bad();
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const total = (db.prepare('SELECT COUNT(*) AS n' + from + where).get(...params) as any).n;
  const items = db.prepare('SELECT l.*,' + owner + ' AS user_id,u.username AS actor_name,owner.username AS user_name' + from + where
    + ' ORDER BY l.id DESC LIMIT ? OFFSET ?').all(...params, pageSize, (page - 1) * pageSize) as FundEntry[];
  const links = hasLinks ? db.prepare('SELECT content_id FROM fund_ledger_content_links WHERE entry_id=? ORDER BY content_id') : null;
  const content = hasContents ? db.prepare("SELECT id,user_id,model_id,status,CASE WHEN json_valid(metadata) THEN json_object('videoId',json_extract(metadata,'$.videoId'),'upstreamTaskId',json_extract(metadata,'$.upstreamTaskId'),'taskId',json_extract(metadata,'$.taskId'),'task_id',json_extract(metadata,'$.task_id'),'upstreamTaskIds',json_extract(metadata,'$.upstreamTaskIds')) ELSE '{}' END AS metadata FROM contents WHERE id=?") : null;
  const receipt = hasTable('video_submission_receipts') ? db.prepare('SELECT upstream_task_id FROM video_submission_receipts WHERE content_id=?') : null;
  const tasks = new Map<number, FundTask>();
  function task(id: number): FundTask {
    if (tasks.has(id)) return tasks.get(id)!;
    const row = content?.get(id) as any;
    let metadata: any = {};
    try { metadata = JSON.parse(row?.metadata || '{}') || {}; } catch {}
    const values = [metadata.videoId, metadata.upstreamTaskId, metadata.taskId, metadata.task_id,
      ...(Array.isArray(metadata.upstreamTaskIds) ? metadata.upstreamTaskIds : []),
      (receipt?.get(id) as any)?.upstream_task_id];
    const upstreamIds = [...new Set(values.filter(v => (typeof v === 'string' || typeof v === 'number') && String(v).trim()
      && String(v).length <= 512 && !/[\s\x00-\x1f]/.test(String(v))).map(v => String(v)))].slice(0, 50);
    const result = { id, model: row?.model_id || null, status: row?.status || null, userId: row?.user_id ?? null, upstreamIds };
    tasks.set(id, result); return result;
  }
  for (const item of items) {
    const ids = new Set<number>();
    if (item.content_id) ids.add(item.content_id);
    for (const link of (links?.all(item.id) || []) as Array<{content_id:number}>) ids.add(link.content_id);
    item.tasks = [...ids].map(task);
    if (item.user_id == null) {
      const owners = [...new Set(item.tasks.map(t => t.userId).filter(id => id != null))];
      if (owners.length === 1) {
        item.user_id = owners[0]!;
        item.user_name = (db.prepare('SELECT username FROM users WHERE id=?').get(item.user_id) as any)?.username ?? null;
      }
    }
  }
  const meta = db.prepare("SELECT value FROM fund_ledger_meta WHERE key='started_at'").get() as any;
  const usageMeta = db.prepare("SELECT value FROM fund_ledger_meta WHERE key='token_usage_started_at'").get() as any;
  return { items, total, page, pageSize, scope, startedAt: meta?.value ?? null, usageStartedAt: usageMeta?.value ?? null };
}
