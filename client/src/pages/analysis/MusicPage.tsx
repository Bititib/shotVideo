import { useEffect, useState } from 'react';
import { AudioLines, Mic, Music2, Play, RefreshCw, Search, Sparkles, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { MusicDownload, MusicWorkspacePlayer, type MusicPlayback } from '../../components/MusicWorkspacePlayer';
import './musicWorkspace.css';
import MusicVoiceRecorder from '../../components/MusicVoiceRecorder';
import { useAuthStore } from '../../stores/authStore';
import { MUSIC_OPERATION_LABELS, songOperation, voiceOperation, type MusicOperation, type MusicTask } from '../../../../shared/sunoMusic';

type Model={id:string;name:string;cost:number;prices:Partial<Record<MusicOperation,number>>};
type Pending={endpoint:string;options:Record<string,unknown>;fileName?:string;fileHash?:string};
const statusName:Record<string,string>={processing:'处理中',review:'待核实',completed:'已完成',failed:'已失败',resolved:'已人工结算',
  partial:'部分完成，待核账',cancelled:'已取消',deleted:'已删除',deleting:'删除待确认',saving:'正在保存'};
const reviewName:Record<string,string>={submission:'提交待核实',query:'查询将在后台重试',storage:'正在尝试保存原结果',
  settlement:'资金待核对',configuration:'原渠道凭据待核对',conflict:'回执冲突',partial:'部分结果和账单待核对'};
const songLabels = { generate: '写新歌', cover: '翻唱', sing: '音色唱新歌', voice_cover: '音色翻唱' };
const voiceLabels = { voice: '普通克隆', enhanced_voice: '强化克隆', voice_from_clip: '从素材创建' };
const libraryViews = ['songs', 'assets', 'voices', 'orders'] as const;
type LibraryView = typeof libraryViews[number];
const libraryLabels: Record<LibraryView, string> = { songs: '我的作品', assets: '歌曲素材', voices: '我的音色', orders: '全部订单' };
const emptyLabels: Record<LibraryView, string> = { songs: '生成的歌曲会显示在这里。', assets: '还没有歌曲素材。', voices: '还没有本人音色。', orders: '还没有音乐订单。' };
const field = 'music-field';

async function fileHash(file:File) {
  const digest=await crypto.subtle.digest('SHA-256',await file.arrayBuffer());
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
}
export default function MusicPage() {
  const user=useAuthStore(s=>s.user);
  return <MusicWorkspace key={user?.id} storageKey={'music-pending-'+user?.id}/>;
}
function MusicWorkspace({storageKey}:{storageKey:string;key?:number}) {
  const [models,setModels]=useState<Model[]>([]),[tasks,setTasks]=useState<MusicTask[]>([]);
  const [assets,setAssets]=useState<MusicTask[]>([]),[voices,setVoices]=useState<MusicTask[]>([]);
  const [view, setView] = useState<LibraryView>('songs');
  const [mobilePanel, setMobilePanel] = useState<'composer' | 'library'>('composer');
  const [search, setSearch] = useState('');
  const [playing, setPlaying] = useState<MusicPlayback | null>(null);
  const [model,setModel]=useState(''),[op,setOp]=useState<MusicOperation>('generate');
  const [prompt,setPrompt]=useState(''),[lyrics,setLyrics]=useState(''),[title,setTitle]=useState(''),[style,setStyle]=useState('');
  const [coverRequirements,setCoverRequirements]=useState('');
  const [mode,setMode]=useState('song'),[custom,setCustom]=useState(false),[maxMode,setMaxMode]=useState(false);
  const [asset,setAsset]=useState(''),[voice,setVoice]=useState(''),[file,setFile]=useState<File|null>(null);
  const [recorded,setRecorded]=useState(false),[recording,setRecording]=useState(false);
  const [rights,setRights]=useState(false),[selfVoice,setSelfVoice]=useState(false);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [pending,setPending]=useState<Pending|null>(()=>{
    try {
      const old=JSON.parse(localStorage.getItem(storageKey)||'null');
      return old?.endpoint?old:old?.client_request_id?{endpoint:'/music',options:old}:null;
    }catch{return null;}
  });
  const locked = busy || recording || Boolean(pending);
  const workItems = view === 'assets' ? assets : view === 'voices' ? voices : view === 'orders' ? tasks
    : tasks.filter(task => !task.operation || songOperation(task.operation));
  const query = search.trim().toLowerCase();
  const visibleItems = workItems.filter(task => !query || [
    task.title, task.prompt, task.model, task.id, task.operation && MUSIC_OPERATION_LABELS[task.operation],
    ...(task.results ?? []).map(result => result.title),
  ].some(value => value?.toLowerCase().includes(query)));
  const selected=models.find(m=>m.id===model);
  const base=selected?.prices?.[op]??(op==='generate'?selected?.cost:undefined);
  const isSong=songOperation(op),isVoice=voiceOperation(op);
  const needsFile=['upload','enhanced_upload','voice','enhanced_voice'].includes(op);
  const needsAsset=['cover','voice_cover','voice_from_clip'].includes(op);
  const needsVoice=op==='sing'||op==='voice_cover';
  const needsRights=['upload','enhanced_upload','enhanced_voice'].includes(op);
  const cost=base===undefined?undefined:Math.round(base*(isSong&&maxMode?2:1)*1e6)/1e6;
  const valid=Boolean(selected&&cost!==undefined&&(!needsAsset||asset)&&(!needsVoice||voice)&&(!needsFile||file)&&
    (!needsRights||rights)&&(!isVoice||selfVoice)&&(op!=='generate'||(custom?style.trim():prompt.trim()))
    &&(op!=='cover'||!custom||style.trim()&&title.trim()));
  const clearPending=()=>{localStorage.removeItem(storageKey);setPending(null);};
  async function collect(){
    const [history,a,v]=await Promise.all([api.get<MusicTask[]>('/music'),api.get<MusicTask[]>('/music/assets'),api.get<MusicTask[]>('/music/voices')]);
    return {history,a,v};
  }
  function update(values:Awaited<ReturnType<typeof collect>>){setTasks(values.history);setAssets(values.a);setVoices(values.v);}
  async function refresh(){try{update(await collect());}catch(e){setError((e as Error).message);}}
  useEffect(()=>{
    let active=true;
    api.get<Model[]>('/music/models').then(rows=>{if(active){setModels(rows);setModel(rows[0]?.id||'');}})
      .catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setLoading(false);});
    const poll=()=>collect().then(values=>{if(active)update(values);}).catch(e=>{if(active)setError(e.message);});
    void poll();const timer=setInterval(()=>void poll(),8000);
    return ()=>{active=false;clearInterval(timer);};
  },[storageKey]);
  function changeOp(value:MusicOperation) {
    setOp(value);setFile(null);setRecorded(false);setRights(false);setSelfVoice(false);setTitle('');setPrompt('');setLyrics('');
    setStyle('');setCoverRequirements('');setMode('song');setCustom(false);setMaxMode(false);setAsset('');setVoice('');
  }
  function openResource(operation: MusicOperation, category: LibraryView) {
    if (operation === 'voice' ? !isVoice : op !== operation) changeOp(operation);
    setView(category);
    setSearch('');
  }
  function showSubmitted(endpoint: string) {
    setView(endpoint === '/music' ? 'songs' : endpoint === '/music/assets' ? 'assets' : 'voices');
    setSearch('');
    setMobilePanel('library');
  }
  async function submit() {
    setBusy(true);setError('');
    try {
      let draft=pending;
      if(draft) {
        const key=encodeURIComponent(String(draft.options.client_request_id));
        try{
          await api.get<MusicTask>('/music/by-request/'+key);
          showSubmitted(draft.endpoint);
          clearPending();await refresh();return;
        }
        catch(error){if((error as {status?:number}).status!==404)throw error;}
      }
      if(!draft) {
        const options:Record<string,unknown>={model,operation:op,client_request_id:crypto.randomUUID(),expected_cost:cost};
        if(needsAsset)options.asset_id=asset;
        if(needsVoice)options.voice_id=voice;
        if(needsRights)options.rights_confirmed=true;
        if(isVoice)options.self_voice_confirmed=true;
        if(recorded&&(op==='voice'||op==='enhanced_voice'))options.source_kind='record';
        if(title&&(isVoice||!isSong||needsVoice||custom))options.title=title;
        if(isSong) {
          options.max_mode=maxMode;
          if(!needsVoice) {
            options.mode=mode;options.custom=custom;
            if(!custom && prompt)options.prompt=prompt;
          }
          if((custom||needsVoice)&&lyrics)options.lyrics=lyrics;
          if((custom||needsVoice)&&style.trim())options.tags=style.split(/[,，]/).map(v=>v.trim()).filter(Boolean);
          if(op==='voice_cover'&&coverRequirements)options.cover_requirements=coverRequirements;
        }
        draft={endpoint:isSong?'/music':isVoice?'/music/voices':'/music/assets',options,
          ...(needsFile&&file?{fileName:file.name,fileHash:await fileHash(file)}:{})};
        localStorage.setItem(storageKey,JSON.stringify(draft));setPending(draft);
      }
      if(draft.fileName) {
        if(!file||draft.fileHash!==await fileHash(file)){setError('请重新选择原文件，以同一请求编号恢复上传。');return;}
        const data=new FormData();data.append('options',JSON.stringify(draft.options));data.append('file',file,draft.fileName);
        await api.post<MusicTask>(draft.endpoint,data);
      } else await api.post<MusicTask>(draft.endpoint,draft.options);
      showSubmitted(draft.endpoint);
      clearPending();setFile(null);setRecorded(false);await refresh();
    } catch(e) {
      const err=e as Error & {status?:number};setError(err.message);
      if(err.status&&[400,401,402,403,404,409].includes(err.status))clearPending();
    } finally {setBusy(false);}
  }
  async function action(task:MusicTask,kind:'cancel'|'delete') {
    if(kind==='delete'&&!window.confirm('删除后，此音色无法继续生成。已生成的歌曲会保留。'))return;
    setBusy(true);setError('');
    try{
      if(kind==='cancel')await api.post('/music/assets/'+task.id+'/cancel');
      else await api.delete('/music/voices/'+task.id);
      await refresh();
    }catch(e){setError((e as Error).message);await refresh();}finally{setBusy(false);}
  }
  function renderStatus(task:MusicTask) {
    return <span className="music-status" data-status={task.status}>{statusName[task.status]||task.status}{task.status==='processing'&&task.progress>0?' · '+task.progress+'%':''}
      {task.error&&task.review_kind?' · '+(reviewName[task.review_kind]||'待核实'):''}
      {' · ¥'+task.cost}{Boolean(task.refund_amount)&&'，已退 ¥'+task.refund_amount}</span>;
  }
  function selectResource(kind: 'asset' | 'voice', id: string) {
    const nextAsset = kind === 'asset' ? id : needsAsset && isSong ? asset : '';
    const nextVoice = kind === 'voice' ? id : needsVoice ? voice : '';
    const next = nextAsset ? nextVoice ? 'voice_cover' : 'cover' : 'sing';
    setOp(next);
    setAsset(nextAsset);
    setVoice(nextVoice);
    if (nextVoice) {
      setMode('song');
      setCustom(false);
    }
    setMobilePanel('composer');
  }
  function renderResources(items: MusicTask[], kind: 'asset' | 'voice') {
    return items.map(item => {
      const isAsset = kind === 'asset';
      const id = isAsset ? item.asset_id : item.voice_id;
      const title = item.title || (isAsset ? '音频素材' : '本人音色');
      const subtitle = item.operation ? MUSIC_OPERATION_LABELS[item.operation] : '';
      return <article key={item.id} className="music-entry">
        <div className="music-track">
          <span className="music-track-icon" aria-hidden="true">{isAsset ? <AudioLines size={19} /> : <Mic size={18} />}</span>
          <div className="music-track-caption"><strong>{title}</strong><span>{subtitle}</span></div>
          <div className="music-track-actions">
            {id && <button type="button" className="music-button" onClick={() => setPlaying({
              url: '/api/music/' + (isAsset ? 'assets' : 'voices') + '/' + item.id + '/file', title, subtitle,
            })}><Play size={15} aria-hidden="true" />试听</button>}
            {id && <button type="button" className="music-button music-button-accent" disabled={locked}
              onClick={() => selectResource(kind, id)}>{isAsset ? '用作翻唱' : '使用音色'}</button>}
          </div>
        </div>
        <div className="music-entry-details">
          {renderStatus(item)}
          {item.error && <p className="music-error">{item.error}</p>}
          <p className="music-order-id">订单 {item.id}</p>
          <div className="music-track-actions">
            {item.can_cancel && <button type="button" className="music-button" disabled={busy} onClick={() => void action(item, 'cancel')}>取消强化上传</button>}
            {!isAsset && ['completed', 'deleting'].includes(item.status) && <button type="button" className="music-button" disabled={busy} onClick={() => void action(item, 'delete')}>
              {item.status === 'deleting' ? '继续核实删除' : '删除音色'}
            </button>}
          </div>
        </div>
      </article>;
    });
  }
  function renderTrack(title: string, subtitle: string, url: string | null, error?: string | null) {
    const track = url ? { url, title, subtitle } : null;
    return <div className="music-track">
      <span className="music-track-icon" aria-hidden="true"><Music2 size={19} /></span>
      <div className="music-track-caption"><strong>{title}</strong><span>{subtitle}</span>{error && <p className="music-error">{error}</p>}</div>
      {track && <div className="music-track-actions">
        <button type="button" className="music-button" onClick={() => setPlaying(track)}><Play size={15} aria-hidden="true" />试听</button>
        <MusicDownload track={track} />
      </div>}
    </div>;
  }
  function renderOrder(task: MusicTask) {
    const heading = task.title || task.prompt || (task.operation ? MUSIC_OPERATION_LABELS[task.operation] : task.model);
    const kind = task.operation ? MUSIC_OPERATION_LABELS[task.operation] : task.model;
    return <article key={task.id} className="music-entry">
      <div className="music-order-header">
        <div className="music-track-caption"><strong>{heading}</strong><span>{kind} · {task.model}</span></div>
        {renderStatus(task)}
      </div>
      {task.error && <p className="music-error">{task.error}</p>}
      {task.results?.map((item, index) => <div key={item.id}>
        {renderTrack(item.title || '版本 ' + (index + 1), statusName[item.status] || item.status, item.result_url, item.error)}
      </div>)}
      {!task.results?.length && task.result_url && renderTrack(heading, '已完成', task.result_url)}
      <p className="music-order-id">订单 {task.id}{task.created_at ? ' · ' + task.created_at : ''}</p>
    </article>;
  }
  return <section className={'music-workspace' + (playing ? ' music-with-player' : '')} aria-labelledby="music-heading">
    <header className="music-header">
      <h1 id="music-heading">音乐工作台</h1>
      <label className="music-model">模型
        <select className={field} value={model} disabled={locked} onChange={e => setModel(e.target.value)}>
          <option value="">请选择</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </label>
    </header>
    {error && <div role="alert" className="music-notice music-notice-error">{error}</div>}
    <div className="music-mobile-tabs music-segments" aria-label="工作台视图">
      <button type="button" aria-pressed={mobilePanel === 'composer'} onClick={() => setMobilePanel('composer')}>创作</button>
      <button type="button" aria-pressed={mobilePanel === 'library'} onClick={() => setMobilePanel('library')}>作品与素材</button>
    </div>
    <div className="music-workspace-body">
      <section className={'music-composer' + (mobilePanel === 'composer' ? ' music-mobile-active' : '')} aria-label="创作区">
        <fieldset disabled={busy || Boolean(pending)} className="music-form">
          <div className="music-segments music-modes" role="group" aria-label="创作方式">
            {(['generate','cover','sing','voice_cover'] as const).map(action => <button type="button" key={action} disabled={recording} aria-pressed={op === action}
              onClick={() => changeOp(action)}>{songLabels[action]}</button>)}
          </div>
          <div className="music-quick-actions" role="group" aria-label="素材与音色入口">
            <button type="button" disabled={recording} aria-pressed={op === 'upload'} onClick={() => openResource('upload', 'assets')}><Upload size={16} aria-hidden="true" />普通上传</button>
            <button type="button" disabled={recording} aria-pressed={op === 'enhanced_upload'} onClick={() => openResource('enhanced_upload', 'assets')}><AudioLines size={16} aria-hidden="true" />强化上传</button>
            <button type="button" disabled={recording} aria-expanded={isVoice} onClick={() => openResource('voice', 'voices')}><Mic size={16} aria-hidden="true" />本人音色</button>
          </div>
          {isVoice && <div className="music-segments" role="group" aria-label="音色创建方式">
            {(['voice', 'enhanced_voice', 'voice_from_clip'] as const).map(value => <button type="button" key={value}
              disabled={recording} aria-pressed={op === value} onClick={() => changeOp(value)}>{voiceLabels[value]}</button>)}
          </div>}
          <div className="music-form-body">
            {loading ? <p role="status" className="music-muted">正在加载模型…</p> : !models.length && <p className="music-muted">暂无可用音乐模型。请管理员设置渠道售价与模型权限。</p>}
            {!isSong && !isVoice && <h2>{MUSIC_OPERATION_LABELS[op]}</h2>}
            {isSong && !needsVoice && <div className="music-options">
              <div className="music-segments" role="group" aria-label="创作模式">
                <button type="button" aria-pressed={!custom} onClick={() => setCustom(false)}>灵感</button>
                <button type="button" aria-pressed={custom} onClick={() => setCustom(true)}>专业</button>
              </div>
              <label className="music-check"><input type="checkbox" checked={mode === 'instrumental'} onChange={e => {setMode(e.target.checked ? 'instrumental' : 'song'); if (e.target.checked) setLyrics('');}} />纯音乐</label>
            </div>}
            {(needsAsset || needsVoice) && <div className="music-references">
              {needsAsset && <label>歌曲素材
                <select className={field} value={asset} onChange={e => setAsset(e.target.value)}>
                  <option value="">{assets.some(t => t.asset_id) ? '请选择已就绪的素材' : '请先上传歌曲素材'}</option>
                  {assets.filter(t => t.asset_id).map(t => <option key={t.id} value={t.asset_id}>{t.title}</option>)}
                </select>
              </label>}
              {needsVoice && <label>我的音色
                <select className={field} value={voice} onChange={e => setVoice(e.target.value)}>
                  <option value="">{voices.some(t => t.voice_id) ? '请选择已就绪的音色' : '请先创建本人音色'}</option>
                  {voices.filter(t => t.voice_id).map(t => <option key={t.id} value={t.voice_id}>{t.title}</option>)}
                </select>
              </label>}
            </div>}
            {needsFile && <div className="music-upload">
              <label>音频文件（{isVoice ? '≤10 MB，至少 6 秒' : '≤40 MB'}）
                <input key={op} className={field} type="file" accept=".mp3,.wav,.m4a,.flac,.ogg,.aac" disabled={recording}
                  onChange={e => {setRecorded(false);setFile(e.target.files?.[0] || null);}} />
              </label>
              {isVoice && <MusicVoiceRecorder onBusy={setRecording} onFile={recording => {setFile(recording);setRecorded(true);}} />}
              {recorded && file && <p role="status">已选择 {file.name}</p>}
            </div>}
            {needsRights && <label className="music-check"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} />我有权上传这段录音并按所选用途使用相关词曲。</label>}
            {isVoice && <label className="music-check"><input type="checkbox" checked={selfVoice} onChange={e => setSelfVoice(e.target.checked)} />这是本人的声音，我同意将样本用于创建演唱音色。</label>}
            {isSong && !needsVoice && !custom && <label>音乐描述
              <textarea className={field} maxLength={3000} rows={6} placeholder="描述你想做的歌，写下风格、情绪或使用场景" value={prompt} onChange={e => setPrompt(e.target.value)} />
            </label>}
            {isSong && (custom || needsVoice) && <>
              {mode !== 'instrumental' && <label>歌词<textarea className={field} maxLength={5000} rows={5} value={lyrics} onChange={e => setLyrics(e.target.value)} /></label>}
              <label>风格<input className={field} maxLength={1000} value={style} onChange={e => setStyle(e.target.value)} placeholder="如：民谣，木吉他，暖色人声" /></label>
            </>}
            {(!isSong || needsVoice || custom) && <label>{isVoice ? '音色名称' : '标题'}
              <input className={field} maxLength={100} value={title} onChange={e => setTitle(e.target.value)} />
            </label>}
            {op === 'voice_cover' && <label>翻唱要求<textarea className={field} maxLength={3000} rows={3} value={coverRequirements} onChange={e => setCoverRequirements(e.target.value)} /></label>}
            {isSong && <label className="music-check"><input type="checkbox" checked={maxMode} onChange={e => setMaxMode(e.target.checked)} />Max Mode（生成价 ×2）</label>}
          </div>
        </fieldset>
        <footer className="music-composer-footer">
          {pending && <div className="music-notice">
            <p role="status">上次提交结果尚未确认。可用同一请求编号核实。</p>
            {pending.fileName && <label>如需恢复上传，请重选 {pending.fileName}<input className={field} type="file" onChange={e => setFile(e.target.files?.[0] || null)} /></label>}
          </div>}
          <button type="button" className="music-submit" disabled={busy || recording || (!pending && !valid)} onClick={() => void submit()}>
            <Sparkles size={17} aria-hidden="true" />
            {busy ? '正在处理…' : pending ? '核实原请求' : MUSIC_OPERATION_LABELS[op] + ' · ' + (cost === undefined ? '暂不可用' : cost === 0 ? '免费' : '¥' + cost)}
          </button>
          {pending && <button type="button" className="music-button" disabled={busy} onClick={() => {
            if (window.confirm('关闭提示不会取消原单，请先检查订单记录再重新生成。')) clearPending();
          }}>关闭恢复提示</button>}
        </footer>
      </section>
      <section className={'music-library' + (mobilePanel === 'library' ? ' music-mobile-active' : '')} aria-labelledby="music-library-heading">
        <header className="music-library-header">
          <div className="music-library-title">
            <h2 id="music-library-heading">{libraryLabels[view]}</h2>
            <button type="button" className="music-button music-icon-button" aria-label="刷新列表" title="刷新列表" onClick={() => void refresh()}><RefreshCw size={16} /></button>
          </div>
          <div className="music-library-controls">
            <div className="music-segments" role="group" aria-label="列表分类">
              {libraryViews.map(category => <button type="button" key={category} aria-pressed={view === category} onClick={() => {setView(category);setSearch('');}}>{libraryLabels[category]}</button>)}
            </div>
            <label className="music-search">
              <Search size={16} aria-hidden="true" />
              <input type="search" aria-label="搜索当前列表" placeholder="搜索名称或订单" value={search} onChange={e => setSearch(e.target.value)} />
            </label>
          </div>
        </header>
        <div className="music-list">
          {!visibleItems.length && <div className="music-empty">
            <span className="music-track-icon" aria-hidden="true"><Music2 size={24} /></span>
            <p>{search.trim() ? '没有匹配的记录。' : emptyLabels[view]}</p>
          </div>}
          {view === 'assets' || view === 'voices' ? renderResources(visibleItems, view === 'assets' ? 'asset' : 'voice') : visibleItems.map(renderOrder)}
        </div>
      </section>
    </div>
    {playing && <MusicWorkspacePlayer key={playing.url} track={playing} onClose={() => setPlaying(null)} />}
  </section>;
}
