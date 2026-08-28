import React, { useState, useEffect, useRef } from 'react';
import { Volume2, Play, Pause, Download, Loader2, Sparkles, AlertCircle, RefreshCw, FileText, Check, Music, Trash2 } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { contentApi } from '../../api/content';
import { useAuthGuard } from '../../hooks/useAuthGuard';

interface VoiceOption {
  id: string;
  name: string;
  gender: 'male' | 'female';
  tags: string[];
  description: string;
}

const VOICE_PRESETS: VoiceOption[] = [
  { id: 'Puck', name: 'Puck', gender: 'male', tags: ['深沉', '成熟'], description: '稳重而有磁性的男声，适合新闻解说、纪录片及正式旁白。' },
  { id: 'Charon', name: 'Charon', gender: 'male', tags: ['活力', '阳光'], description: '充满朝气与亲和力的男声，非常适合科技数码测评与生活分享。' },
  { id: 'Kore', name: 'Kore', gender: 'female', tags: ['知性', '温柔'], description: '温和优雅的女声，适合情感解读、故事朗读及有声书。' },
  { id: 'Fenrir', name: 'Fenrir', gender: 'male', tags: ['硬朗', '激情'], description: '力量感十足的男声，非常适合短视频带货、促销广告及激情解说。' },
  { id: 'Aoede', name: 'Aoede', gender: 'female', tags: ['甜美', '可爱'], description: '清脆甜美的女声，适合美妆好物分享、萌宠日常及娱乐八卦。' },
  { id: 'Zephyr', name: 'Zephyr', gender: 'male', tags: ['自然', '磁性'], description: '极具自然感与叙事感的男声，适合长视频解说、电影旁白。' },
  { id: 'Despina', name: 'Despina', gender: 'female', tags: ['干练', '职业'], description: '清晰爽朗的职业女声，适合企业宣传片、课程讲解及商业演示。' },
];

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
  const [models, setModels] = useState<{ modelId: string; displayName: string }[]>([]);
  const [selectedModel, setSelectedModel] = useState('');
  const [selectedVoice, setSelectedVoice] = useState('Zephyr');
  const [text, setText] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentAudio, setCurrentAudio] = useState<GeneratedVoice | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [history, setHistory] = useState<GeneratedVoice[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 1. 初始化，加载可用模型与历史记录
  // 1. 初始化，加载可用模型与历史记录
  useEffect(() => {
    analysisApi.getTtsModels()
      .then((res: any) => {
        const list = res?.data || res || [];
        if (list.length > 0) {
          setModels(list);
          setSelectedModel(list[0].modelId);
        } else {
          // 兜底配置
          const defaultTts = [
            { modelId: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', rate: 0.01 },
            { modelId: 'gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', rate: 0.02 },
          ];
          setModels(defaultTts);
          setSelectedModel(defaultTts[0].modelId);
        }
      })
      .catch(() => {
        const defaultTts = [
          { modelId: 'gemini-2.5-flash-preview-tts', displayName: 'Gemini 2.5 Flash TTS', rate: 0.01 },
          { modelId: 'gemini-2.5-pro-preview-tts', displayName: 'Gemini 2.5 Pro TTS', rate: 0.02 },
        ];
        setModels(defaultTts);
        setSelectedModel(defaultTts[0].modelId);
      });

    // 加载历史音频
    loadHistory();
  }, []);

  const loadHistory = (page = 1, append = false) => {
    setHistoryLoading(true);
    contentApi.getMyContents({ type: 'audio', page, pageSize: 12 })
      .then((res: any) => {
        const items = res?.items || res?.data || [];
        const loadedHistory: GeneratedVoice[] = [];
        for (const item of items) {
          try {
            const data = JSON.parse(item.resultText);
            if (data.audioBase64) {
              const audioUrl = base64ToBlobUrl(data.audioBase64, data.mimeType || 'audio/mp3');
              loadedHistory.push({
                id: item.id.toString(),
                text: item.inputText || '',
                voice: item.title?.replace('语音合成 - ', '') || '未知',
                audioUrl,
                createdAt: new Date(item.createdAt),
              });
            }
          } catch (e) {
            // 忽略格式不正确的
          }
        }
        setHistory(prev => append ? [...prev, ...loadedHistory.filter(item => !prev.some(old => old.id === item.id))] : loadedHistory);
        setHistoryPage(page);
        setHistoryTotal(Number(res?.total) || 0);
      })
      .catch(() => {})
      .finally(() => setHistoryLoading(false));
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
    if (!text.trim() || isGenerating) return;
    if (!guard()) return;

    setIsGenerating(true);
    setError(null);

    try {
      const res = await analysisApi.generateTts(text.trim(), selectedVoice, selectedModel);
      const audioBase64 = res.audioBase64;
      const mimeType = res.mimeType || 'audio/mp3';

      if (!audioBase64) {
        throw new Error('未返回有效的音频数据');
      }

      const audioUrl = base64ToBlobUrl(audioBase64, mimeType);
      const newVoice: GeneratedVoice = {
        id: Date.now().toString(),
        text: text.trim(),
        voice: selectedVoice,
        audioUrl,
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
    <div className="tts-page flex h-full flex-col lg:flex-row">
      {/* ===== 左栏：控制配置 ===== */}
      <div className="w-full lg:w-[360px] shrink-0 h-fit lg:h-full lg:overflow-y-auto border-r border-white/5 bg-black p-6 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="flex flex-col gap-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/20 to-amber-600/20 border border-yellow-500/30 flex items-center justify-center">
              <Volume2 className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">语音合成 (TTS)</h2>
              <p className="text-xs text-zinc-500">将文本转化为超逼真的拟真语音</p>
            </div>
          </div>

          {/* 模型选择 */}
          <div>
            <label className="block text-xs font-semibold text-zinc-400 mb-2 uppercase tracking-wider">选择模型</label>
            <div className="grid grid-cols-1 gap-2">
              {models.map((model) => (
                <button
                  key={model.modelId}
                  onClick={() => setSelectedModel(model.modelId)}
                  className={`flex items-center justify-between px-4 py-3 rounded-xl border text-left transition-all ${
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
                          ¥{model.rate.toFixed(2)}/字
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

          {/* 音色选择 */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-zinc-400 uppercase tracking-wider">选择音色</label>
              <span className="text-[10px] text-zinc-500">共 {VOICE_PRESETS.length} 种音色可选</span>
            </div>
            <div className="space-y-2 max-h-[350px] overflow-y-auto pr-1 [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
              {VOICE_PRESETS.map((v) => (
                <button
                  key={v.id}
                  onClick={() => setSelectedVoice(v.id)}
                  className={`w-full text-left p-3 rounded-xl border transition-all flex flex-col gap-1.5 ${
                    selectedVoice === v.id
                      ? 'border-yellow-500/50 bg-yellow-500/5 shadow-lg'
                      : 'border-white/5 bg-white/[0.01] hover:border-white/10 hover:bg-white/[0.03]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-white">{v.name}</span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-medium ${
                        v.gender === 'male' ? 'bg-blue-500/10 text-blue-400' : 'bg-pink-500/10 text-pink-400'
                      }`}>
                        {v.gender === 'male' ? '男声' : '女声'}
                      </span>
                    </div>
                    <div className="flex gap-1">
                      {v.tags.map(t => (
                        <span key={t} className="text-[9px] bg-white/5 text-zinc-400 px-1 py-0.5 rounded">{t}</span>
                      ))}
                    </div>
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">{v.description}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ===== 右栏：文本输入与音频播放 ===== */}
      <div className="tts-content-panel flex-1 flex flex-col min-w-0 bg-[#070707] relative p-6 lg:overflow-y-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: 'none' }}>
        <div className="max-w-4xl mx-auto w-full flex flex-col gap-6 h-full">
          {/* 输入及合成区 */}
          <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-zinc-400">输入文本</span>
              <span className="text-[10px] text-zinc-600">{text.length} / 2000 字</span>
            </div>

            <textarea
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, 2000))}
              placeholder="请输入你想合成为语音的文字，支持中英文混排..."
              rows={6}
              className="w-full bg-black/40 border border-white/5 focus:border-yellow-500/30 rounded-xl p-4 text-sm text-white focus:outline-none placeholder:text-zinc-600 resize-none"
            />

            {/* 模板快速填充 */}
            <div className="flex flex-col gap-2">
              <span className="text-[10px] text-zinc-500 flex items-center gap-1">
                <FileText className="w-3 h-3" /> 常用文案模板：
              </span>
              <div className="flex gap-2 flex-wrap">
                {TEXT_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.title}
                    onClick={() => setText(tpl.text)}
                    className="text-[10px] bg-white/5 hover:bg-white/10 text-zinc-300 px-2.5 py-1.5 rounded-lg border border-white/5 transition-all"
                  >
                    {tpl.title}
                  </button>
                ))}
              </div>
            </div>

            {/* 生成按钮 */}
            <div className="flex items-center justify-between border-t border-white/5 pt-4 mt-2">
              <div className="text-[11px] text-zinc-500 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-yellow-500/70" />
                推荐使用 Zephyr 或 Kore 音色，拟真效果极佳
              </div>
              <button
                onClick={handleGenerate}
                disabled={!text.trim() || isGenerating}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-medium text-black bg-gradient-to-r from-yellow-500 to-amber-500 hover:from-yellow-400 hover:to-amber-400 disabled:opacity-30 disabled:cursor-not-allowed shadow-lg shadow-yellow-500/10 transition-all shrink-0"
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

          {/* 当前音频播放器 */}
          {currentAudio && (
            <div className="bg-gradient-to-r from-yellow-500/10 to-amber-600/10 border border-yellow-500/20 rounded-2xl p-5 flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-semibold text-yellow-400">当前合成的语音</span>
                  <p className="text-[10px] text-zinc-500 mt-0.5">音色: {currentAudio.voice} · 格式: MP3</p>
                </div>
                <a
                  href={currentAudio.audioUrl}
                  download={`tts_${currentAudio.voice}_${Date.now()}.mp3`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg text-[10px] text-zinc-300 transition-colors border border-white/5"
                >
                  <Download className="w-3 h-3" /> 下载音频
                </a>
              </div>

              {/* 音频条 */}
              <div className="flex items-center gap-4 bg-black/40 rounded-xl p-4 border border-white/5">
                <button
                  onClick={togglePlay}
                  className="w-10 h-10 rounded-full bg-yellow-500 flex items-center justify-center text-black hover:scale-105 transition-transform"
                >
                  {isPlaying ? <Pause className="w-4 h-4 fill-black" /> : <Play className="w-4 h-4 fill-black ml-0.5" />}
                </button>

                <div className="flex-1 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-[10px] text-zinc-500 tabular-nums">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={duration || 0}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="w-full accent-yellow-500 bg-white/10 h-1 rounded-lg appearance-none cursor-pointer"
                  />
                </div>

                {/* 动态音浪 */}
                <div className="flex items-end gap-0.5 h-6">
                  {[...Array(8)].map((_, i) => (
                    <div
                      key={i}
                      className={`w-0.5 bg-yellow-500/80 rounded-full transition-all duration-300`}
                      style={{
                        height: isPlaying ? `${Math.floor(Math.random() * 100)}%` : '15%',
                        animation: isPlaying ? `wave 1.2s ease-in-out infinite alternate` : 'none',
                        animationDelay: `${i * 0.15}s`
                      }}
                    />
                  ))}
                </div>
              </div>

              {/* 文本预览 */}
              <div className="bg-black/20 rounded-xl p-3 border border-white/5">
                <span className="text-[10px] text-zinc-600 block mb-1">文字脚本：</span>
                <p className="text-[11px] text-zinc-400 leading-relaxed line-clamp-3">{currentAudio.text}</p>
              </div>
            </div>
          )}

          {/* 历史生成列表 */}
          {history.length > 0 && (
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-400">历史合成记录 ({history.length})</span>
                <button onClick={() => loadHistory(1, false)} className="text-zinc-500 hover:text-zinc-300 text-[10px] flex items-center gap-1 transition-colors">
                  <RefreshCw className="w-3 h-3" /> 刷新
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {history.map((h) => (
                  <div
                    key={h.id}
                    onClick={() => {
                      setCurrentAudio(h);
                      setIsPlaying(true);
                    }}
                    className={`p-4 rounded-xl border transition-all cursor-pointer flex items-center justify-between gap-4 ${
                      currentAudio?.id === h.id
                        ? 'border-yellow-500/30 bg-yellow-500/5'
                        : 'border-white/5 bg-white/[0.01] hover:border-white/10 hover:bg-white/[0.02]'
                    }`}
                  >
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-white">音色: {h.voice}</span>
                        <span className="text-[9px] text-zinc-500">{h.createdAt.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
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
                        {currentAudio?.id === h.id && isPlaying ? (
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
