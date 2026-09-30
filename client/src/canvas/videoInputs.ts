import type { CanvasNode, GenerationDraft } from './model';
import { canvasVideoReferenceLimits } from '../../../shared/canvasVideoReferences';

export const VIDEO_EDIT_MODEL = 'veo-omni-flash-video-edit';

/** Validate the same constraints before both enabling Generate and submitting. */
export function videoInputError(options: Pick<GenerationDraft, 'kind' | 'videoMode' | 'model' | 'ratio' | 'seconds'>, references: CanvasNode[]): string {
  const pending = references.find(n => n.job?.status === 'running' || (n.kind === 'text' ? !n.text.trim() : !n.src));
  if (pending) return `参考节点「${pending.title}」${pending.job?.status === 'running' ? '正在生成，请等待完成' : '还没有内容，请先上传或生成素材'}。`;
  if (options.kind === 'audio' && references.some(n => n.kind !== 'text')) return '语音合成只使用文字参考，不支持媒体参考或音色克隆。';
  if (options.kind === 'video' && options.videoMode === 'text' && references.some(n => n.kind === 'image')) return '已连接图片，请切换图片参考模式后生成。';
  if (options.kind !== 'video') return references.some(n => n.kind === 'video' || n.kind === 'audio') ? '此模式不支持视频或音频参考，请移除对应连线或切换视频编辑。' : '';
  const videos = references.filter(n => n.kind === 'video' && n.src);
  const audios = references.filter(n => n.kind === 'audio' && n.src);
  if (options.videoMode === 'edit') {
    if (videos.length !== 1) return '视频编辑需要且只能连接一个原视频。';
    if (audios.length) return '此视频编辑模型不支持音频参考，请移除音频连线。';
    if (options.model !== VIDEO_EDIT_MODEL) return '请选择可用的视频编辑模型。';
    if (!['16:9', '9:16'].includes(options.ratio)) return '视频编辑支持 16:9 或 9:16 画幅。';
    if (options.seconds !== 10) return '此视频编辑模型固定输出 10 秒。';
  } else if (options.videoMode === 'multimodal') {
    const limits = canvasVideoReferenceLimits(options.model);
    if (!limits) return '请选择支持视频 / 音频参考的模型。';
    if (references.filter(n => n.kind === 'image' && n.src).length > limits.images || videos.length > limits.videos || audios.length > limits.audios) return `此模型最多支持 ${limits.images} 张图片、${limits.videos} 个视频、${limits.audios} 段音频参考。`;
    if (limits.wavOnly && audios.some(n => !/^data:audio\/(x-)?wav[;,]/i.test(n.src!) && !n.src!.split('?')[0].toLowerCase().endsWith('.wav'))) return '此模型的参考音频仅支持 WAV，请更换音频或模型。';
  } else {
    if (options.model === VIDEO_EDIT_MODEL) return '请切换到视频编辑模式。';
    if (videos.length || audios.length) return '当前模式不支持视频或音频参考。请切换多模态参考；编辑原视频请切换视频编辑模式。';
  }
  return '';
}

export function readVideoDuration(src: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const finish = (error?: Error) => {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      const duration = video.duration;
      video.onloadedmetadata = null; video.onerror = null; video.removeAttribute('src'); video.load();
      if (error) reject(error); else resolve(duration);
    };
    const abort = () => finish(new Error('已取消视频读取'));
    const timer = setTimeout(() => finish(new Error('原视频读取超时，请确认素材能够播放后重试。')), 15000);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    video.preload = 'metadata';
    video.onloadedmetadata = () => finish(!Number.isFinite(video.duration) || video.duration <= 0 ? new Error('无法确认原视频时长，请重新导入视频。') : video.duration > 15 ? new Error('原视频超过 15 秒，请先截取到 15 秒以内。') : undefined);
    video.onerror = () => finish(new Error('无法读取原视频，请检查素材地址或重新导入。'));
    video.src = src.startsWith('data:') || src.startsWith('blob:') ? src : `/api/video/play?url=${encodeURIComponent(src)}`;
  });
}

/** Type compatibility is independent of whether an upstream node is ready yet. */
export function connectionError(source: CanvasNode, target: CanvasNode): string {
  if (target.kind === 'text') return '文字节点不接收生成参考，请连接图像、视频或音频生成节点。';
  if (target.kind === 'audio' && source.kind !== 'text') return '语音合成只支持文字参考。';
  if (target.kind === 'image' && (source.kind === 'video' || source.kind === 'audio')) return '图像生成不支持视频或音频参考，请连接视频生成节点。';
  if (target.job?.status === 'running') return '此节点正在生成，请完成后再调整参考。';
  return '';
}
