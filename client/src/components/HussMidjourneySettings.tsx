import React from 'react';
import type { HussMjOptions } from '../../../shared/hussMidjourney';
export function HussMidjourneySettings({mjOptions,setMjOptions}:{mjOptions:HussMjOptions;setMjOptions:React.Dispatch<React.SetStateAction<HussMjOptions>>}) {
  return <details className="ig-mj-options"><summary>风格参数</summary>
            <p>水彩、油画、动漫等风格写入图片描述；也可提供风格参考图。</p>
            <div className="ig-mj-fields">
              <label>渲染模式<select value={String(mjOptions.style || '')} onChange={e => setMjOptions(v => ({...v,style:e.target.value}))}><option value="">默认</option><option value="raw">Raw</option></select></label>
              {([['stylize','风格化强度',1000,100],['sw','风格参考强度',1000,100],['chaos','变化程度',100,0],['weird','奇异程度',3000,0],['seed','随机种子',4294967295,0],['iw','普通参考图权重',3,2]] as const).map(([key,label,max,defaultValue]) => <label key={key}>{label}<input type="number" min={0} max={max} step={key === 'iw' ? 0.1 : 1} placeholder={String(defaultValue)} value={String(mjOptions[key] ?? '')} onChange={e => setMjOptions(v => ({...v,[key]:e.target.value === '' ? undefined : key === 'seed' ? Number(e.target.value) : e.target.value}))}/></label>)}
              <label>风格参考图直链<input type="url" placeholder="https://…" value={String(mjOptions.sref || '')} onChange={e => setMjOptions(v => ({...v,sref:e.target.value}))}/></label>
              <label>排除内容<input value={String(mjOptions.negative_prompt || '')} onChange={e => setMjOptions(v => ({...v,negative_prompt:e.target.value}))}/></label>
              <label><input type="checkbox" checked={mjOptions.tile === true} onChange={e => setMjOptions(v => ({...v,tile:e.target.checked}))}/>无缝平铺</label>
            </div>
          </details>;
}
