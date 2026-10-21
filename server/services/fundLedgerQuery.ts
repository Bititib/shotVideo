import type Database from 'better-sqlite3';
import { FUND_ACCOUNTS, FUND_KINDS } from '../../shared/fundLedger.js';
import { beijingDayBounds, beijingDateKey } from '../../shared/time.js';
export function listFundLedger(db:Database.Database, query:Record<string,unknown>) {
  const bad=()=>{throw Object.assign(new Error('流水筛选参数无效'),{status:400});};
  const integer=(value:unknown,fallback:number,max:number)=>{if(value===undefined||value==='')return fallback;if(typeof value!=='string'&&typeof value!=='number')return bad();const n=Number(value);if(!Number.isInteger(n)||n<1||n>max)return bad();return n;};
  const page=integer(query.page,1,1000000),pageSize=integer(query.pageSize,30,100);
  const conditions:string[]=[],params:any[]=[];
  for(const [key,column,allowed] of [['accountType','account_type',FUND_ACCOUNTS],['kind','kind',FUND_KINDS]] as const){
    if(query[key]){if(typeof query[key]!=='string'||!Object.hasOwn(allowed,query[key] as string))bad();conditions.push('l.'+column+'=?');params.push(query[key]);}
  }
  if(query.accountId){conditions.push('l.account_id=?');params.push(integer(query.accountId,0,Number.MAX_SAFE_INTEGER));}
  if(query.userId!==undefined&&query.userId!==''){conditions.push('l.user_id=?');params.push(integer(query.userId,0,Number.MAX_SAFE_INTEGER));}
  if(query.search){if(typeof query.search!=='string'||query.search.length>100)bad();conditions.push('instr(l.account_name,?)>0');params.push(query.search);}
  for(const key of ['from','to'])if(query[key]){
    if(typeof query[key]!=='string')bad();const day=query[key] as string,bounds=beijingDayBounds(day);
    if(!bounds||beijingDateKey(new Date(day+'T00:00:00+08:00'))!==day)bad();
    conditions.push('l.created_at'+(key==='from'?'>=?':'<?'));params.push(key==='from'?bounds!.start:bounds!.end);
  }
  if(query.from&&query.to&&String(query.from)>String(query.to))bad();
  const where=conditions.length?' WHERE '+conditions.join(' AND '):'';
  const total=(db.prepare('SELECT COUNT(*) AS n FROM fund_ledger l'+where).get(...params) as any).n;
  const items=db.prepare('SELECT l.*,u.username AS actor_name,owner.username AS user_name FROM fund_ledger l LEFT JOIN users u ON u.id=l.actor_id LEFT JOIN users owner ON owner.id=l.user_id'+where+' ORDER BY l.id DESC LIMIT ? OFFSET ?').all(...params,pageSize,(page-1)*pageSize);
  const meta=db.prepare("SELECT value FROM fund_ledger_meta WHERE key='started_at'").get() as any;
  const usageMeta=db.prepare("SELECT value FROM fund_ledger_meta WHERE key='token_usage_started_at'").get() as any;
  return {items,total,page,pageSize,startedAt:meta?.value??null,usageStartedAt:usageMeta?.value??null};
}
