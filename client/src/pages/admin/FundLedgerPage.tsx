import React,{useEffect,useState} from 'react';
import {api} from '../../api/client';
import {FUND_ACCOUNTS,FUND_KINDS,type FundLedgerResult} from '../../../../shared/fundLedger';
import {formatBeijingTime} from '../../../../shared/time';
const initial={accountType:'',accountId:'',kind:'',search:'',from:'',to:''};
const money=(value:number)=>value.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6});
export default function FundLedgerPage(){
 const [draft,setDraft]=useState(initial),[filters,setFilters]=useState(initial),[page,setPage]=useState(1),[refresh,setRefresh]=useState(0);
 const [data,setData]=useState<FundLedgerResult|null>(null),[busy,setBusy]=useState(true),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');
 const params=new URLSearchParams({...filters,page:String(page),pageSize:'30'});
 api.get<FundLedgerResult>('/admin/fund-ledger?'+params,{signal:controller.signal}).then(result=>{if(!controller.signal.aborted)setData(result);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});return()=>controller.abort();
 },[filters,page,refresh]);
 const field=(key:keyof typeof initial,value:string)=>setDraft({...draft,[key]:value});
 return <div className="space-y-5">
 <div className="flex flex-wrap gap-3 items-center justify-between"><div><h1 className="text-2xl font-bold">资金流水</h1><p className="text-sm opacity-70 mt-2">仅管理员可见 · 个人、组织余额与 Token 额度变动记录</p></div><button className="border rounded-xl px-4 py-2" disabled={busy} onClick={()=>setRefresh(v=>v+1)}>刷新</button></div>
 <div className="rounded-xl border p-4 text-sm leading-6">{data?.startedAt?'记录启用时间：'+formatBeijingTime(data.startedAt)+'（北京时间）。':'从功能启用后开始记录。'}启用时余额是核对起点，不代表历史充值。管理员加减余额记为“管理员调账”；Token 额度与账户余额分开核对，无限 Token 的累计用量不计作余额流水。</div>
 <form className="flex flex-wrap gap-3 rounded-xl border p-4 items-end" onSubmit={e=>{e.preventDefault();setPage(1);setFilters({...draft});}}>
 <label className="text-sm">账户类型<select aria-label="账户类型" className="block border rounded-lg p-2 mt-1" value={draft.accountType} onChange={e=>field('accountType',e.target.value)}><option value="">全部账户</option>{Object.entries(FUND_ACCOUNTS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label className="text-sm">账户 ID<input aria-label="账户 ID" type="number" min="1" className="block border rounded-lg p-2 mt-1 w-28" value={draft.accountId} onChange={e=>field('accountId',e.target.value)}/></label>
 <label className="text-sm">账户名称<input aria-label="账户名称" className="block border rounded-lg p-2 mt-1 w-40" value={draft.search} onChange={e=>field('search',e.target.value)} maxLength={100}/></label>
 <label className="text-sm">变动类型<select aria-label="变动类型" className="block border rounded-lg p-2 mt-1" value={draft.kind} onChange={e=>field('kind',e.target.value)}><option value="">全部类型</option>{Object.entries(FUND_KINDS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
 <label className="text-sm">开始日期<input aria-label="开始日期" type="date" className="block border rounded-lg p-2 mt-1" value={draft.from} onChange={e=>field('from',e.target.value)}/></label>
 <label className="text-sm">结束日期<input aria-label="结束日期" type="date" className="block border rounded-lg p-2 mt-1" value={draft.to} onChange={e=>field('to',e.target.value)}/></label>
 <button className="rounded-lg px-4 py-2 bg-[#53684c] text-white" style={{color:"#fff"}} type="submit">查询</button><button className="border rounded-lg px-4 py-2" type="button" onClick={()=>{setDraft(initial);setFilters(initial);setPage(1);}}>清空</button></form>
 {error&&<p role="alert" className="text-red-700">{error}</p>}
 <div className="overflow-x-auto rounded-xl border" aria-busy={busy}><table className="w-full text-sm text-left whitespace-nowrap"><thead className="bg-black/5"><tr>{['时间（北京） / 流水号','账户','类型','变动金额 / 额度','变动前 → 变动后','操作人','关联任务'].map(h=><th key={h} className="p-3">{h}</th>)}</tr></thead><tbody>{!busy&&!error&&data?.items.map(item=><tr key={item.id} className="border-t"><td className="p-3">{formatBeijingTime(item.created_at)}<div className="text-xs opacity-60">#{item.id}</div></td><td className="p-3">{item.account_name||'未命名'}<div className="text-xs opacity-60">{FUND_ACCOUNTS[item.account_type]} #{item.account_id}</div></td><td className="p-3">{FUND_KINDS[item.kind]||item.kind}</td><td className="p-3 font-medium">{item.delta===null?'额度模式变更':(item.delta>0?'+':'')+money(item.delta)}</td><td className="p-3">{item.account_type==='token'&&item.balance_before===-1?'不限额':money(item.balance_before)} → {item.account_type==='token'&&item.balance_after===-1?'不限额':money(item.balance_after)}</td><td className="p-3">{item.actor_id?(item.actor_name||'管理员')+' #'+item.actor_id:'系统 / 未记录'}</td><td className="p-3">{item.content_id?'#'+item.content_id:'—'}</td></tr>)}</tbody></table>{busy?<p className="p-8 text-center">正在读取流水…</p>:!error&&!data?.items.length?<p className="p-8 text-center">暂无符合条件的流水</p>:null}</div>
 <div className="flex gap-4 items-center justify-end text-sm"><span>共 {data?.total??0} 条 · 第 {page} 页</span><button className="border rounded-lg px-3 py-2" disabled={busy||page===1} onClick={()=>setPage(p=>p-1)}>上一页</button><button className="border rounded-lg px-3 py-2" disabled={busy||page*30>=(data?.total??0)} onClick={()=>setPage(p=>p+1)}>下一页</button></div>
 </div>;
}
