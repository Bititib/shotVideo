export const HM_STUDIO_CHANNEL_TYPE = 'hmstudio';

export type HmStudioVideoOptions = {
  model: string;
  prompt: string;
  duration: number;
  ratio: string;
  resolution: string;
  imageSources?: string[];
  videoSources?: string[];
  audioSources?: string[];
  firstFrame?: string;
  lastFrame?: string;
  functionMode?: string;
  upstreamChannel?: string;
};

export type NormalizedHmStudioTask = {
  status: string;
  progress: number;
  resultUrl: string;
  error: string;
};

export type HmStudioImageOptions = {
  model: string;
  prompt: string;
  ratio: string;
  resolution?: string;
  imageSources?: string[];
  negativePrompt?: string;
  sampleStrength?: number;
  intelligentRatio?: boolean;
  upstreamChannel?: string;
};

export function isHmStudioChannel(channel: { type?: string } | null | undefined): boolean {
  return channel?.type === HM_STUDIO_CHANNEL_TYPE;
}

export function hmStudioCreateUrl(baseUrl: string, kind: 'image' | 'video'): string {
  const root = baseUrl.replace(/\/+$/, '');
  return `${root}/v1/${kind === 'video' ? 'videos' : 'images'}/generations`;
}

export function hmStudioTaskUrl(baseUrl: string, taskId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v1/tasks/${encodeURIComponent(taskId)}`;
}

function dataUrlToBlob(source: string): { blob: Blob; extension: string } | null {
  const match = source.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;

  const mimeType = match[1];
  const buffer = Buffer.from(match[2], 'base64');
  const subtype = mimeType.split('/')[1]?.split('+')[0] || 'bin';
  const extension = subtype === 'jpeg' ? 'jpg' : subtype;
  return { blob: new Blob([buffer], { type: mimeType }), extension };
}

function appendFileOrUrl(
  form: FormData,
  fileField: string,
  urlField: string,
  source: string,
  fallbackExtension: string,
): void {
  const parsed = dataUrlToBlob(source);
  if (parsed) {
    form.append(fileField, parsed.blob, `${fileField}.${parsed.extension || fallbackExtension}`);
  } else if (source) {
    form.append(urlField, source);
  }
}

function replaceReferenceMarkers(prompt: string): string {
  return prompt
    .replace(/\[ref_(\d+)(?:\.[a-zA-Z0-9]+)?\]/g, (_match, rawIndex) => {
      const parsed = Number(rawIndex);
      const index = parsed === 0 ? 1 : parsed;
      return `@Image${index}`;
    })
    .replace(/\[ref_video_(\d+)\]/g, (_match, rawIndex) => `@Video${Number(rawIndex) || 1}`)
    .replace(/\[ref_video\]/g, '@Video1')
    .replace(/\[ref_audio_(\d+)\]/g, (_match, rawIndex) => `@Audio${Number(rawIndex) || 1}`)
    .replace(/\[ref_audio\]/g, '@Audio1');
}

function appendOmniReferences(
  form: FormData,
  images: string[],
  videos: string[],
  audios: string[],
): void {
  const materials: Array<{ type: 'image' | 'video' | 'audio'; name: string; url?: string }> = [];

  const appendMaterial = (type: 'image' | 'video' | 'audio', source: string, index: number) => {
    const name = `${type === 'image' ? 'Image' : type === 'video' ? 'Video' : 'Audio'}${index + 1}`;
    const parsed = dataUrlToBlob(source);
    if (parsed) {
      form.append(`${type}_file_${index + 1}`, parsed.blob, `${name}.${parsed.extension}`);
      materials.push({ type, name });
    } else if (source) {
      materials.push({ type, name, url: source });
    }
  };

  images.forEach((source, index) => appendMaterial('image', source, index));
  videos.forEach((source, index) => appendMaterial('video', source, index));
  audios.forEach((source, index) => appendMaterial('audio', source, index));
  if (materials.length > 0) form.append('materials', JSON.stringify(materials));
}

/** Build the multipart request expected by HM Studio's compatible video API. */
export function buildHmStudioVideoForm(options: HmStudioVideoOptions): FormData {
  const images = (options.imageSources || []).filter(Boolean);
  const videos = (options.videoSources || []).filter(Boolean);
  const audios = (options.audioSources || []).filter(Boolean);
  const explicitFrames = [options.firstFrame, options.lastFrame].filter(Boolean) as string[];

  let functionMode = options.functionMode || '';
  if (!functionMode) {
    if (videos.length > 0 || audios.length > 0 || images.length > 2) {
      functionMode = /SD2\.0(?:Fast)?/i.test(options.model) ? 'omni_reference' : 'multi_frame';
    } else if (explicitFrames.length > 0 || images.length > 0) {
      functionMode = 'first_last_frames';
    }
  }

  const form = new FormData();
  form.append('model', options.model);
  form.append('prompt', functionMode === 'omni_reference' ? replaceReferenceMarkers(options.prompt) : options.prompt);
  form.append('duration', String(options.duration));
  form.append('ratio', options.ratio);
  form.append('video_resolution', options.resolution);
  if (functionMode) form.append('function_mode', functionMode);
  if (options.upstreamChannel) form.append('channel', options.upstreamChannel);

  if (functionMode === 'omni_reference') {
    appendOmniReferences(form, [...explicitFrames, ...images], videos, audios);
  } else if (functionMode === 'multi_frame') {
    const frames = [...explicitFrames, ...images];
    const frameUrls: string[] = [];
    frames.forEach((source, index) => {
      const parsed = dataUrlToBlob(source);
      if (parsed) form.append(`frame_${index + 1}`, parsed.blob, `frame_${index + 1}.${parsed.extension}`);
      else if (source) frameUrls.push(source);
    });
    if (frameUrls.length > 0) form.append('multi_frames', JSON.stringify(frameUrls));
  } else {
    const first = options.firstFrame || images[0];
    const last = options.lastFrame || images[1];
    if (first) appendFileOrUrl(form, 'first_frame', 'first_frame_url', first, 'jpg');
    if (last) appendFileOrUrl(form, 'end_frame', 'end_frame_url', last, 'jpg');
  }

  return form;
}

/** Build the multipart request expected by HM Studio's compatible image API. */
export function buildHmStudioImageForm(options: HmStudioImageOptions): FormData {
  const form = new FormData();
  form.append('model', options.model);
  form.append('prompt', options.prompt);
  form.append('ratio', options.ratio);
  form.append('resolution', options.resolution || '2k');
  if (options.negativePrompt) form.append('negative_prompt', options.negativePrompt);
  if (options.sampleStrength !== undefined) form.append('sample_strength', String(options.sampleStrength));
  if (options.intelligentRatio !== undefined) form.append('intelligent_ratio', String(options.intelligentRatio));
  if (options.upstreamChannel) form.append('channel', options.upstreamChannel);

  const imageUrls: string[] = [];
  for (const source of (options.imageSources || []).filter(Boolean).slice(0, 10)) {
    const parsed = dataUrlToBlob(source);
    if (parsed) form.append('images', parsed.blob, `reference.${parsed.extension}`);
    else imageUrls.push(source);
  }
  if (imageUrls.length === 1) form.append('image_url', imageUrls[0]);
  if (imageUrls.length > 1) form.append('image_urls', JSON.stringify(imageUrls));
  return form;
}

function parseProgress(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.min(100, value));
  const parsed = Number.parseInt(String(value ?? '0'), 10);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, parsed)) : 0;
}

function resolveResultUrl(value: unknown, baseUrl: string): string {
  const url = typeof value === 'string' ? value : '';
  if (!url) return '';
  return url.startsWith('/') ? `${baseUrl.replace(/\/+$/, '')}${url}` : url;
}

/** Normalize HM Studio's asynchronous task response for both live and recovered polling. */
export function normalizeHmStudioTask(raw: any, baseUrl: string): NormalizedHmStudioTask {
  const payload = raw?.data && typeof raw.data === 'object' ? raw.data : raw || {};
  const status = String(payload.status || raw?.status || '').toLowerCase();
  const resultUrls = Array.isArray(payload.result_urls)
    ? payload.result_urls
    : Array.isArray(raw?.result_urls) ? raw.result_urls : [];
  const resultUrl = resolveResultUrl(
    resultUrls[0]
      || payload.video_url
      || payload.image_url
      || payload.result_url
      || payload.url
      || payload.result?.url,
    baseUrl,
  );
  const errorValue = payload.fail_reason || payload.failure_reason || payload.error || raw?.fail_reason || raw?.error;
  const error = typeof errorValue === 'object' && errorValue
    ? String(errorValue.message || JSON.stringify(errorValue))
    : String(errorValue || '');

  return {
    status,
    progress: status === 'success' || status === 'completed' ? 100 : parseProgress(payload.progress ?? raw?.progress),
    resultUrl,
    error,
  };
}

export async function waitForHmStudioTask(options: {
  baseUrl: string;
  taskId: string;
  apiKey?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
  onProgress?: (task: NormalizedHmStudioTask) => void;
}): Promise<NormalizedHmStudioTask> {
  const deadline = Date.now() + (options.timeoutMs || 10 * 60_000);
  const headers: Record<string, string> = {};
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;

  while (Date.now() < deadline) {
    const response = await fetch(hmStudioTaskUrl(options.baseUrl, options.taskId), {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HM Studio task query failed (${response.status}): ${detail.slice(0, 300)}`);
    }

    const task = normalizeHmStudioTask(await response.json(), options.baseUrl);
    options.onProgress?.(task);
    if (task.status === 'success' || task.status === 'completed') {
      if (!task.resultUrl) throw new Error('HM Studio task succeeded without a result URL');
      return task;
    }
    if (task.status === 'failed' || task.status === 'failure') {
      throw new Error(task.error || 'HM Studio task failed');
    }
    await new Promise(resolve => setTimeout(resolve, options.pollIntervalMs || 3000));
  }

  throw new Error('HM Studio task polling timed out');
}
