import React, { useEffect, useState } from 'react';
import { adminApi } from '../api/admin';
import { type KkVideoRouting, type KkVideoSource } from '../../../shared/kkVideoRouting';
import './KkVideoRoutingControl.css';

export default function KkVideoRoutingControl({ disabled, onSaved, onBusyChange }: { disabled: boolean; onSaved: () => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [data, setData] = useState<any>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [value, setValue] = useState<KkVideoRouting>({ primary: 'stable', fallback: false, channelId: 0 });
  const load = async () => {
    try {
      const result = await adminApi.getKkRouting();
      setData(result); setError('');
      setValue(result.current || { primary: 'stable', fallback: false, channelId: result.channels.find((c: any) => c.ready)?.id || 0 });
    } catch (e: any) { setError(e.message); }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  const save = async () => {
    if (busy || disabled || !data) return;
    setBusy(true); setError('');
    try { await adminApi.saveKkRouting(value, data.version); await onSaved(); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <section className="kk-routing-control" aria-label="KK 自动分流设置">
    <div><strong>KK 自动分流</strong><p>{data?.current ? '已保存：' + (data.current.primary === 'stable' ? '稳定优先' : 'KK 优先') + '，自动分流' + (data.current.fallback ? '已开启' : '已关闭') : '尚未配置，继续沿用现有线路'}</p>
      <p>仅对新提交生效。明确未接单才切换；已取得任务编号或提交结果不明时继续处理原请求。售价保持原设置。</p>
      {error && <p role="alert">{error}</p>}
      {!data && <button className="routing-button" onClick={() => void load()}>重新加载分流设置</button>}
      {disabled && <p>请先保存或取消其他规格修改，再设置分流。</p>}
    </div>
    <fieldset className="routing-fields" disabled={disabled || busy || !data}>
      <label>分流渠道<select className="routing-input" value={value.channelId} onChange={e => setValue({ ...value, channelId: Number(e.target.value) })}>
        <option value={0}>请选择渠道</option>{data?.channels.map((c: any) => <option key={c.id} value={c.id} disabled={!c.ready}>{c.name}{c.ready ? '' : '（未就绪）'}</option>)}
      </select></label>
      <label>首选线路<select className="routing-input" value={value.primary} onChange={e => setValue({ ...value, primary: e.target.value as KkVideoSource })}>
        <option value="stable">稳定seadanco2.5-720</option><option value="kk">kkseadanco2.5</option>
      </select></label>
      <button type="button" role="switch" aria-checked={value.fallback} aria-label="自动分流" className="routing-button" onClick={() => setValue({ ...value, fallback: !value.fallback })}>自动分流：{value.fallback ? '开启' : '关闭'}</button>
      <button className="routing-button is-primary" disabled={!value.channelId} onClick={() => void save()}>{busy ? '正在保存…' : '保存分流设置'}</button>
    </fieldset>
  </section>;
}
