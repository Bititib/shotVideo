import './TtsPage.css';
import { ttsVoices, audioExtension, type TtsVoice } from '../../../../shared/tts';
import React, { useState, useEffect, useRef } from 'react';
import { Volume2, Play, Pause, Download, Loader2, Sparkles, AlertCircle, RefreshCw, FileText, Check, Music, Trash2 } from 'lucide-react';
import { analysisApi, getCachedTtsModels, type StudioVoice } from '../../api/analysis';
import { contentApi } from '../../api/content';
import { formatBeijingTime, parseUtcTimestamp } from '../../../../shared/time';
import { useAuthGuard } from '../../hooks/useAuthGuard';

const TEXT_TEMPLATES = [
  {
    title: '短视频带货开场',
    text: '家人们！今天给大家带货的这款神器，真的绝了！平时我们洗碗最烦的就是油污洗不干净，但是有了它，轻轻一擦，秒变干净！今天直播间厂家直发，直接破盘价！赶紧点击下方小黄车抢购吧！',
  },
  {
    title: '影视故事解说',
    text: '注意看，眼前这个男人叫小帅，他怎么也没想到，自己只是一觉醒来，世界竟然已经过去了五百年。身边的废墟上长满了奇怪的植物，而远处的天空，三个太阳正散发着诡异的光芒。',
  },
  {
    title: '情感暖心旁白',
    text: '其实，我们每个人都在寻找那个能听懂自己沉默的人。在这个步履不停的世界里，愿有一盏灯为你而留，愿有一声问候能温暖你疲惫的旅途。晚安，每一个努力生活的你。',
  },
];

interface GeneratedVoice {
  id: string;
  text: string;
  voice: string;
  audioUrl: string;
  mimeType?: string;
  createdAt: Date;
}
function base64ToBlobUrl(base64: string, mimeType: string): string {
  try {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });
    return URL.createObjectURL(blob);
  } catch (e) {
    console.error('Failed to convert base64 to blob url:', e);
    return `data:${mimeType};base64,${base64}`;
  }
}

export default function TtsPage() {
  const guard = useAuthGuard();
  const [models, setModels] = useState(getCachedTtsModels);
  const [selectedModel, setSelectedModel] = useState(() => models[0]?.modelId || '');
  const activeModel = models.find(m => m.modelId === selectedModel);
  const voices = ttsVoices(activeModel?.voices);
  const [clones, setClones] = useState<StudioVoice[]>([]);
  const [cloneName, setCloneName] = useState('');
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const cloneInputRef = useRef<HTMLInputElement | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);
  const [cloneMessage, setCloneMessage] = useState('');
  const chooseCloneFile = (file?: File) => {
    if (!file) return;
    setCloneMessage('');
    if (file.size > 10 * 1024 * 1024) { setCloneMessage('音频超过 10MB，请压缩或裁剪后上传'); return; }
    if (!/\.(wav|mp3|ogg)$/i.test(file.name)) { setCloneMessage('请选择 WAV、MP3 或 OGG 文件'); return; }
    setCloneFile(file);
  };
  const loadClones = async () => {
    const list = await analysisApi.getClonedVoices();
    setClones(list.filter(v => v.type === 'cloned'));
  };
  useEffect(() => { loadClones().catch(() => {}); }, []);
  const [voiceSearch, setVoiceSearch] = useState('');
  const [modelsLoading, setModelsLoading] = useState(true);
  const voiceDetails = new Map<string, TtsVoice>(activeModel?.voiceDetails?.map(v => [v.id, v]) || []);
  const visibleVoices = voices.filter(id => {
    const v = voiceDetails.get(id);
    return [id, v?.description, v?.style, v?.scenario].join(' ').toLowerCase().includes(voiceSearch.trim().toLowerCase());
  });
  const [selectedVoice, setSelectedVoice] = useState('');
  const actualVoice = selectedVoice;
  useEffect(() => {
    setSelectedVoice(current => voices.includes(current) || clones.some(v => v.voiceId === current && v.state === 'ACTIVE') ? current : (voices[0] || ''));
  }, [voices, clones]);
  const [text, setText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAudio, setCurrentAudio] = useState<GeneratedVoice | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [history, setHistory] = useState<GeneratedVoice[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyAudioLoadingId, setHistoryAudioLoadingId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  const loadModels = async (force = false) => {
    setModelsLoading(true);
    try {
      const list = await analysisApi.getTtsModels(force);
      setModels(list);
      setSelectedModel(current => list.some(model => model.modelId === current) ? current : list[0]?.modelId || '');
      setError(list.length ? null : '暂无可用语音模型，请联系管理员配置。');
    } catch {
      setModels([]); setSelectedModel('');
      setError('语音模型加载失败，请点击刷新重试。');
    } finally { setModelsLoading(false); }
  };
  useEffect(() => { void loadModels(); loadHistory(); }, []);

  const loadHistory = (page = 1, append = false) => {
    setHistoryLoading(true);
    contentApi.getMyContents({ type: 'audio', page, pageSize: 12 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        const loadedHistory: GeneratedVoice[] = [];
        for (const item of items) {
          let audioUrl = '';
          let mimeType = 'audio/wav';
          try {
            const data = JSON.parse(item.resultText || '{}');
            mimeType = data.mimeType || 'audio/wav';
            if (data.audioBase64) {
              audioUrl = base64ToBlobUrl(data.audioBase64, mimeType);
            }
          } catch (e) {
            // 忽略格式不正确的
          }
          if (item.status === 'completed' || item.status === 'success' || audioUrl) {
            loadedHistory.push({
              id: item.id.toString(),
              text: item.inputText || '',
              voice: item.title?.replace('语音合成 - ', '') || '未知',
              audioUrl,
              mimeType,
              createdAt: new Date(parseUtcTimestamp(item.createdAt)),
            });
          }
        }
        setHistory(prev => append ? [...prev, ...loadedHistory.filter(item => !prev.some(old => old.id === item.id))] : loadedHistory);
        setHistoryPage(page);
        setHistoryTotal(Number(res?.total) || 0);
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
  };

  const selectHistoryAudio = async (historyItem: GeneratedVoice) => {
    if (historyItem.audioUrl) {
      setCurrentAudio(historyItem);
      setIsPlaying(true);
      return;
    }

    setHistoryAudioLoadingId(historyItem.id);
    setError(null);
    try {
      const detail: any = await contentApi.getById(Number(historyItem.id));
      const data = JSON.parse(detail?.resultText || '{}');
      if (!data.audioBase64) throw new Error('该历史记录没有可播放的音频数据');
      const loadedItem = {
        ...historyItem,
        mimeType: data.mimeType || 'audio/wav',
        audioUrl: base64ToBlobUrl(data.audioBase64, data.mimeType || 'audio/wav'),
      };
      setHistory(prev => prev.map(item => item.id === loadedItem.id ? loadedItem : item));
      setCurrentAudio(loadedItem);
      setIsPlaying(true);
    } catch (historyError: any) {
      setError(historyError?.message || '历史音频加载失败，请稍后重试');
    } finally {
      setHistoryAudioLoadingId(null);
    }
  };

  // 2. 音频控制逻辑
  useEffect(() => {
    if (currentAudio) {
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(currentAudio.audioUrl);
      audioRef.current = audio;

      audio.addEventListener('play', () => setIsPlaying(true));
      audio.addEventListener('pause', () => setIsPlaying(false));
      audio.addEventListener('ended', () => {
        setIsPlaying(false);
        setCurrentTime(0);
      });
      audio.addEventListener('timeupdate', () => {
        setCurrentTime(audio.currentTime);
      });
      audio.addEventListener('loadedmetadata', () => {
        setDuration(audio.duration);
      });

      if (isPlaying) {
        audio.play().catch(() => setIsPlaying(false));
      }
    }

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, [currentAudio]);

  const togglePlay = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(() => setIsPlaying(false));
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!audioRef.current) return;
    const time = parseFloat(e.target.value);
    audioRef.current.currentTime = time;
    setCurrentTime(time);
  };

  // 3. 生成音频
  const handleGenerate = async () => {
    if (!text.trim() || isGenerating || !selectedModel || !actualVoice || modelsLoading) return;
    if (!guard()) return;

    setIsGenerating(true);
    setError(null);

    try {
      const res = await analysisApi.generateTts(text.trim(), actualVoice, selectedModel);
      const audioBase64 = res.audioBase64;
      const mimeType = res.mimeType || 'audio/wav';
      if (res.warning) setCloneMessage(res.warning);

      if (!audioBase64) {
        throw new Error('未返回有效的音频数据');
      }

      const audioUrl = base64ToBlobUrl(audioBase64, mimeType);
      const newVoice: GeneratedVoice = {
        id: Date.now().toString(),
        text: text.trim(),
        voice: res.usedVoice || actualVoice,
        audioUrl,
        mimeType,
        createdAt: new Date(),
      };

      setCurrentAudio(newVoice);
      setIsPlaying(true);
      // 重新加载历史
      setTimeout(loadHistory, 1000);
    } catch (err: any) {
      console.error(err);
      setError(err.response?.data?.error || err.message || '语音合成失败，请重试');
    } finally {
      setIsGenerating(false);
    }
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="tts-page tts-workbench">
      {/* ===== 左栏：控制配置 ===== */}
      <div className="tts-controls" style={{ scrollbarWidth: 'none' }}>
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/20 to-amber-600/20 border border-yellow-500/30 flex items-center justify-center">
              <Volume2 className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">声音与表现</h2>
              <p className="text-xs text-zinc-500">模型与音色设置</p>
            </div>
          </div>

          {/* 模型选择 */}
          <div>
            <div className="tts-section-heading"><label>01 · 选择模型</label><button type="button" onClick={() => void loadModels(true)} disabled={modelsLoading || isGenerating} aria-label="刷新模型列表"><RefreshCw size={14} className={modelsLoading ? 'animate-spin' : ''} />{modelsLoading ? '加载中' : '刷新'}</button></div>
            <div className="tts-model-grid">
              {models.map((model) => (
                <button
                  key={model.modelId}
                  aria-pressed={selectedModel === model.modelId}
                  disabled={isGenerating}
                  onClick={() => setSelectedModel(model.modelId)}
                  className={`tts-model-card flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-all ${
                    selectedModel === model.modelId
                      ? 'border-yellow-500/50 bg-yellow-500/5 text-white'
                      : 'border-white/5 bg-white/[0.02] text-zinc-400 hover:border-white/10 hover:bg-white/[0.04]'
                  }`}
                >
                  <div className="flex-1 min-w-0 pr-2">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium truncate">{model.displayName}</p>
                      {model.rate !== undefined && (
                        <span className="text-[9px] bg-yellow-500/10 text-yellow-500 px-1.5 py-0.5 rounded border border-yellow-500/20 font-medium shrink-0">
                          ¥{model.rate}/字
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-zinc-500 mt-0.5 truncate">{model.modelId}</p>
                  </div>
                  {selectedModel === model.modelId && (
                    <div className="w-4 h-4 rounded-full bg-yellow-500 flex items-center justify-center shrink-0">
                      <Check className="w-2.5 h-2.5 text-black font-bold" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          </div>

          <section className="tts-voice-section">
            <h3>预置音色</h3>
            <div className="tts-section-heading"><label>02 · 选择声音</label><span>共 {voices.length} 个音色</span></div>
            <input className="tts-voice-search" aria-label="搜索音色" placeholder="搜索名称、风格或使用场景…" value={voiceSearch} onChange={e => setVoiceSearch(e.target.value)} />
            <div className="tts-voice-grid">
              {visibleVoices.map(id => {
                const voice = voiceDetails.get(id);
                return <button key={id} aria-label={id} aria-pressed={selectedVoice === id} onClick={() => setSelectedVoice(id)} title={voice?.displayName || id}>
                  <span className="tts-voice-copy"><span className="tts-voice-name">{id}{selectedVoice === id && <Check size={13} />}</span>
                  {voice?.gender && <small>{voice.gender === 'female' ? '女声' : voice.gender === 'male' ? '男声' : voice.gender}{voice.style ? ' · ' + voice.style : ''}</small>}
                  {voice?.description && <span className="tts-voice-description">{voice.description}</span>}
                  {voice?.scenario && <small>{voice.scenario}</small>}</span>
                </button>;
              })}
            </div>
            {voices.length > 0 && !visibleVoices.length && <p className="tts-hint">没有匹配的音色，请换个名称搜索。</p>}
            <p className="tts-hint">{activeModel?.voiceSource === 'upstream' ? '音色信息来自上游服务。' : '上游尚未返回音色列表，暂时无法选择音色。'}</p>
            <details className="tts-clone-disclosure" open><summary>我的克隆音色</summary>
            <div className="tts-clone-panel">
              <h3>克隆音色</h3>
              <p className="tts-hint">上传 10～30 秒清晰的单人录音，支持 WAV、MP3、OGG，最大 10MB。请使用本人或已获授权的声音。</p>
              <input className="tts-voice-search" aria-label="克隆音色名称" placeholder="为声音起个名字" maxLength={60} value={cloneName} onChange={e => setCloneName(e.target.value)} />
              <input ref={cloneInputRef} hidden aria-label="参考音频" type="file" accept=".wav,.mp3,.ogg,audio/wav,audio/mpeg,audio/ogg" disabled={cloneBusy} onChange={e => {
                chooseCloneFile(e.target.files?.[0]);
                e.target.value = '';
              }} />
              <div className="tts-audio-upload" onDragOver={e => e.preventDefault()} onDrop={e => {
                e.preventDefault();
                if (!cloneBusy) chooseCloneFile(e.dataTransfer.files?.[0]);
              }}>
                <button type="button" disabled={cloneBusy} onClick={() => cloneInputRef.current?.click()}>{cloneFile ? '更换参考音频' : '上传参考音频'}</button>
                <span role="status">{cloneFile ? `${cloneFile.name} · ${(cloneFile.size / 1024 / 1024).toFixed(2)} MB` : '点击按钮选择文件，也可将音频拖到这里'}</span>
              </div>
              <button type="button" disabled={cloneBusy || !cloneFile || !cloneName.trim()} onClick={async () => {
                if (!guard() || !cloneFile) return;
                setCloneBusy(true); setCloneMessage('');
                try {
                  const created = await analysisApi.cloneVoice(cloneFile, cloneName.trim());
                  await loadClones();
                  if (created.state === 'ACTIVE') setSelectedVoice(created.voiceId);
                  setCloneMessage(created.state === 'ACTIVE' ? '声音克隆成功，可以选择该音色生成配音。' : `音色已保存，当前状态：${created.state}`);
                } catch (e: any) { setCloneMessage(e.message || '克隆失败，请重试'); }
                finally { setCloneBusy(false); }
              }}>{cloneBusy ? '正在克隆…' : '创建克隆音色'}</button>
              <button type="button" disabled={cloneBusy} onClick={() => { if (guard()) loadClones().catch(e => setCloneMessage(e.message)); }}>刷新我的音色</button>
              {cloneMessage && <p role="status" className="tts-hint">{cloneMessage}</p>}
              {clones.map(v => <div className="tts-clone-row" key={v.voiceId}>
                <button type="button" aria-pressed={selectedVoice === v.voiceId} disabled={v.state !== 'ACTIVE' || isGenerating} onClick={() => setSelectedVoice(v.voiceId)}>{v.displayName}{v.state !== 'ACTIVE' ? ` · ${v.state}` : ''}</button>
                <button type="button" aria-label={`删除音色 ${v.displayName}`} disabled={cloneBusy || isGenerating} onClick={async () => {
                  if (!confirm(`删除克隆音色“${v.displayName}”？删除后无法继续使用此声音。`)) return;
                  setCloneBusy(true);
                  try { await analysisApi.deleteClonedVoice(v.voiceId); await loadClones(); setCloneMessage('克隆音色已删除'); }
                  catch (e: any) { setCloneMessage(e.message); }
                  finally { setCloneBusy(false); }
                }}><Trash2 size={14} /></button>
              </div>)}
            </div>
            </details>
          </section>
        </div>
      </div>

      {/* ===== 右栏：文本输入与音频播放 ===== */}
      <div className="tts-content-panel" style={{ scrollbarWidth: 'none' }}>
        <div className="tts-main-stack">
          <div className="tts-composer-heading"><div><span className="tts-eyebrow">TEXT TO SPEECH</span><h1>让文字拥有声音</h1><p>从一段文案开始，创作你的下一段配音。</p></div><div className="tts-selection-summary"><span>{activeModel?.displayName || '请选择模型'}</span><strong>{actualVoice || '请选择音色'}</strong></div></div>
          <section className="tts-scenarios" aria-label="文案场景">{TEXT_TEMPLATES.map((tpl, i) => <button type="button" key={tpl.title} aria-pressed={text === tpl.text} onClick={() => setText(tpl.text)}><Sparkles size={18} /><strong>{tpl.title}</strong><span>{['抓住注意力，讲清产品卖点', '用声音带观众走进故事', '温柔表达，让情绪自然流动'][i]}</span></button>)}</section>
          {/* 输入及合成区 */}
          <div className="tts-editor-card">
            <header className="tts-editor-toolbar"><span>单人配音</span><small>支持中英文文案</small></header>
            <div className="tts-editor-label flex items-center justify-between">
              <label htmlFor="tts-transcript" className="text-xs font-semibold text-zinc-400">配音文案</label>
              <span className="text-[10px] text-zinc-600">{text.length} / 2000 字</span>
            </div>

            <textarea id="tts-transcript"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 2000))}
              placeholder="请输入你想合成为语音的文字，支持中英文混排..."
              rows={9}
              className="w-full bg-black/40 border border-white/5 focus:border-yellow-500/30 rounded-xl p-4 text-sm text-white focus:outline-none placeholder:text-zinc-600 resize-none"
            />

            <div className="tts-editor-footer"><span>正文将用于语音合成</span><button type="button" disabled={!text || isGenerating} onClick={() => setText('')}>清空文案</button></div>
            {/* 生成按钮 */}
            <div className="tts-submit-row">
              <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-yellow-500/70" />
                {activeModel?.rate !== undefined ? `预计 ¥${(text.trim().length * activeModel.rate).toFixed(2)} · 按输入字数计费` : '请选择模型后生成'}
              </div>
              <button
                onClick={handleGenerate}
                disabled={!text.trim() || isGenerating || !selectedModel || !actualVoice || modelsLoading}
                className="tts-generate-button"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> 合成中...
                  </>
                ) : (
                  <>
                    <Music className="w-3.5 h-3.5" /> 开始合成语音
                  </>
                )}
              </button>
            </div>
          </div>

          {/* 错误提示 */}
          {error && (
            <div className="px-4 py-3 bg-red-500/10 border border-red-500/20 rounded-xl text-xs text-red-400 flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {currentAudio && <section className="tts-player-dock" aria-label="音频播放器"><div className="tts-player-info"><Volume2 size={20} /><div><strong>{currentAudio.text}</strong><span>{currentAudio.voice} · {audioExtension(currentAudio.mimeType).toUpperCase()}</span></div></div><button type="button" className="tts-player-toggle" aria-label={isPlaying ? '暂停音频' : '播放音频'} onClick={togglePlay}>{isPlaying ? <Pause size={19} /> : <Play size={19} />}</button><input aria-label="播放进度" type="range" min={0} max={duration || 0} step={0.1} value={currentTime} onChange={handleSeek} /><span className="tts-player-time">{formatTime(currentTime)} / {formatTime(duration)}</span><a href={currentAudio.audioUrl} download={'tts_' + Date.now() + '.' + audioExtension(currentAudio.mimeType)} aria-label="下载音频"><Download size={18} /></a></section>}

          {!history.length && <section className="tts-empty"><Music size={25} /><h3>最近的声音</h3><p>{historyLoading ? '正在读取记录…' : '生成第一段配音后，在这里试听和回看。'}</p></section>}
          {/* 历史生成列表 */}
          {history.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-400">最近的声音 ({history.length})</span>
                <button onClick={() => loadHistory(1, false)} className="text-zinc-500 hover:text-zinc-300 text-[10px] flex items-center gap-1 transition-colors">
                  <RefreshCw className="w-3 h-3" /> 刷新
                </button>
              </div>

              <div className="tts-history-list">
                {history.map((h) => (
                  <div
                    key={h.id}
                    onClick={() => { void selectHistoryAudio(h); }}
                    className={`p-4 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-4 ${
                      currentAudio?.id === h.id
                        ? 'border-yellow-500/30 bg-yellow-500/5'
                        : 'border-white/5 bg-white/[0.01] hover:border-white/10 hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white">音色: {h.voice}</span>
                        <span className="text-[9px] text-zinc-500" title="北京时间">{formatBeijingTime(h.createdAt, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                      <p className="text-[10px] text-zinc-500 truncate leading-relaxed">{h.text}</p>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button onClick={async (e) => {
                        e.stopPropagation();
                        if (window.confirm('确定要删除这条语音合成记录吗？')) {
                          try {
                            await contentApi.delete(h.id);
                            setHistory(prev => prev.filter(item => item.id !== h.id));
                            if (currentAudio?.id === h.id) {
                              setCurrentAudio(null);
                              setIsPlaying(false);
                            }
                          } catch (err) {
                            console.error('Failed to delete tts history:', err);
                            alert('删除失败');
                          }
                        }
                      }} className="w-8 h-8 rounded-full bg-white/5 hover:bg-red-500/10 text-zinc-400 hover:text-red-400 flex items-center justify-center transition-colors" title="删除记录">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <button className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 text-zinc-300 transition-colors">
                        {historyAudioLoadingId === h.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : currentAudio?.id === h.id && isPlaying ? (
                          <Pause className="w-3.5 h-3.5 fill-current" />
                        ) : (
                          <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                        )}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {historyPage * 12 < historyTotal && (
                <div className="flex justify-center pt-2">
                  <button type="button" disabled={historyLoading} onClick={() => loadHistory(historyPage + 1, true)} className="rounded-xl border border-white/10 bg-white/5 px-5 py-2 text-xs text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-wait disabled:opacity-50">
                    {historyLoading ? '加载中…' : '加载更多'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* 关键帧音浪动画关键CSS */}
        <style dangerouslySetInnerHTML={{__html: `
          @keyframes wave {
            0% { height: 15%; }
            100% { height: 100%; }
          }
        `}} />
      </div>
    </div>
  );
}
