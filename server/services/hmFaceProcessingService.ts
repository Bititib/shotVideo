import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-web';

const INPUT_SIZE = 640;
const SCORE_THRESHOLD = 0.55;
const NMS_THRESHOLD = 0.3;
const STRIDES = [8, 16, 32] as const;
const MAX_CANDIDATES = 5000;
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

type Box = { x: number; y: number; w: number; h: number };
type Face = Box & { score: number; kps: number[] };
type FaceRegions = { box: Box; eyes: Box; mouth: Box; frontal: number };

export type HmFaceProcessingDetails = {
  faceCount: number;
  cutCount: number;
  maskedCount: number;
  width: number;
  height: number;
};

export type HmFaceProcessingResult = {
  source: string;
  details: HmFaceProcessingDetails;
};

let sessionPromise: Promise<ort.InferenceSession> | null = null;
let inferenceChain = Promise.resolve();

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function modelPath(): string {
  const candidates = [
    path.join(process.cwd(), 'client', 'public', 'face-processing', 'assets', 'models', 'face_detection_yunet_2023mar.onnx'),
    path.join(process.cwd(), 'client', 'dist', 'face-processing', 'assets', 'models', 'face_detection_yunet_2023mar.onnx'),
  ];
  const resolved = candidates.find(candidate => fs.existsSync(candidate));
  if (!resolved) throw new Error('YuNet 人脸检测模型文件不存在');
  return resolved;
}

function wasmPath(file: string): string {
  return path.join(process.cwd(), 'node_modules', 'onnxruntime-web', 'dist', file);
}

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.simd = true;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmPaths = {
        'ort-wasm-simd.wasm': wasmPath('ort-wasm-simd.wasm'),
        'ort-wasm.wasm': wasmPath('ort-wasm.wasm'),
      };
      return ort.InferenceSession.create(fs.readFileSync(modelPath()), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });
    })().catch(error => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
}

function iou(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.w * a.h + b.w * b.h - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function nonMaximumSuppression(faces: Face[]): Face[] {
  const sorted = faces.slice().sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
  const result: Face[] = [];
  for (const face of sorted) {
    if (!result.some(kept => iou(face, kept) >= NMS_THRESHOLD)) result.push(face);
  }
  return result;
}

function outputData(value: ort.Tensor | undefined): Float32Array {
  if (!value) throw new Error('YuNet 输出不完整');
  return value.data instanceof Float32Array ? value.data : Float32Array.from(value.data as ArrayLike<number>);
}

function decodeDetections(outputs: Record<string, ort.Tensor>, scale: number): Face[] {
  const detections: Face[] = [];
  for (const stride of STRIDES) {
    const cls = outputData(outputs[`cls_${stride}`]);
    const obj = outputData(outputs[`obj_${stride}`]);
    const bbox = outputData(outputs[`bbox_${stride}`]);
    const kps = outputData(outputs[`kps_${stride}`]);
    const gridWidth = INPUT_SIZE / stride;
    const count = gridWidth * gridWidth;
    for (let index = 0; index < count; index++) {
      const score = Math.sqrt(Math.max(0, cls[index] * obj[index]));
      if (score < SCORE_THRESHOLD) continue;
      const row = Math.floor(index / gridWidth);
      const column = index - row * gridWidth;
      const width = Math.exp(bbox[index * 4 + 2]) * stride;
      const height = Math.exp(bbox[index * 4 + 3]) * stride;
      const points = new Array<number>(10);
      for (let point = 0; point < 5; point++) {
        points[point * 2] = ((column + kps[index * 10 + point * 2]) * stride) / scale;
        points[point * 2 + 1] = ((row + kps[index * 10 + point * 2 + 1]) * stride) / scale;
      }
      detections.push({
        score,
        x: ((column + bbox[index * 4]) * stride - width / 2) / scale,
        y: ((row + bbox[index * 4 + 1]) * stride - height / 2) / scale,
        w: width / scale,
        h: height / scale,
        kps: points,
      });
    }
  }
  return nonMaximumSuppression(detections);
}

function isValidFace(face: Face, width: number, height: number): boolean {
  if (face.score < 0.5 || face.w <= 1 || face.h <= 1) return false;
  if (face.w < width * 0.012 && face.h < height * 0.012) return false;
  const ratio = face.h / Math.max(1, face.w);
  if (ratio < 0.45 || ratio > 2.4) return false;
  const rightEye = { x: face.kps[0], y: face.kps[1] };
  const leftEye = { x: face.kps[2], y: face.kps[3] };
  const nose = { x: face.kps[4], y: face.kps[5] };
  const mouth = { x: (face.kps[6] + face.kps[8]) / 2, y: (face.kps[7] + face.kps[9]) / 2 };
  const eyeY = (rightEye.y + leftEye.y) / 2;
  const eyeDistance = Math.hypot(rightEye.x - leftEye.x, rightEye.y - leftEye.y);
  if (mouth.y < eyeY || mouth.y < nose.y - face.h * 0.05) return false;
  if (eyeDistance < 1 && Math.abs(mouth.y - eyeY) < face.h * 0.08) return false;
  return [rightEye, leftEye, nose, mouth].filter(point =>
    point.x > face.x - face.w * 0.35 && point.x < face.x + face.w * 1.35
    && point.y > face.y - face.h * 0.25 && point.y < face.y + face.h * 1.25,
  ).length >= 3;
}

function isFrontal(face: Face, width: number, height: number): boolean {
  if (!isValidFace(face, width, height)) return false;
  const rightEyeX = face.kps[0];
  const leftEyeX = face.kps[2];
  const eyeDistance = Math.hypot(rightEyeX - leftEyeX, face.kps[1] - face.kps[3]);
  return eyeDistance >= face.w * 0.2
    && face.kps[4] >= Math.min(rightEyeX, leftEyeX)
    && face.kps[4] <= Math.max(rightEyeX, leftEyeX);
}

function centeredBox(cx: number, cy: number, width: number, height: number, imageWidth: number, imageHeight: number): Box {
  const w = Math.max(8, width);
  const h = Math.max(8, height);
  const x = clamp(Math.round(cx - w / 2), 0, imageWidth - 2);
  const y = clamp(Math.round(cy - h / 2), 0, imageHeight - 2);
  return {
    x,
    y,
    w: clamp(Math.round(w), 2, imageWidth - x),
    h: clamp(Math.round(h), 2, imageHeight - y),
  };
}

function faceRegions(face: Face, width: number, height: number): FaceRegions | null {
  if (!isValidFace(face, width, height)) return null;
  const eye1 = { x: face.kps[0], y: face.kps[1] };
  const eye2 = { x: face.kps[2], y: face.kps[3] };
  const nose = { x: face.kps[4], y: face.kps[5] };
  const mouth = { x: (face.kps[6] + face.kps[8]) / 2, y: (face.kps[7] + face.kps[9]) / 2 };
  const eyeCenter = { x: (eye1.x + eye2.x) / 2, y: (eye1.y + eye2.y) / 2 };
  const eyeDistance = Math.hypot(eye1.x - eye2.x, eye1.y - eye2.y);
  const cropUnit = Math.max(face.w * 0.42, eyeDistance, face.h * 0.22);
  let eyes = centeredBox(eyeCenter.x, eyeCenter.y - cropUnit * 0.04, cropUnit * 1.732, cropUnit * 0.866, width, height);
  let lips = centeredBox(mouth.x, mouth.y + cropUnit * 0.06, cropUnit * 1.196, cropUnit * 0.936, width, height);
  const minimumMouthY = Math.round(Math.max(eyes.y + eyes.h * 0.55, nose.y + cropUnit * 0.16));
  if (lips.y < minimumMouthY) {
    const delta = minimumMouthY - lips.y;
    lips = { ...lips, y: minimumMouthY, h: clamp(lips.h - delta + Math.round(cropUnit * 0.08), 8, height - minimumMouthY) };
  }
  if (lips.y < eyes.y + eyes.h + Math.max(6, Math.round(cropUnit * 0.08))) {
    const midpoint = (eyes.y + eyes.h + lips.y) / 2;
    eyes = { ...eyes, h: Math.max(2, Math.round(midpoint - cropUnit * 0.04 - eyes.y)) };
    const newY = clamp(Math.round(midpoint + cropUnit * 0.04), lips.y, lips.y + lips.h - 2);
    lips = { ...lips, y: newY, h: lips.y + lips.h - newY };
  }
  const normalizedEyeDistance = eyeDistance / Math.max(1, face.w);
  const level = 1 - clamp(Math.abs(eye1.y - eye2.y) / Math.max(eyeDistance, 1), 0, 1);
  let frontal = normalizedEyeDistance > 0.22 ? 0.22 + 0.36 * (0.4 + 0.6 * level) : 0.08;
  if (nose.x > Math.min(eye1.x, eye2.x) && nose.x < Math.max(eye1.x, eye2.x)) frontal += 0.22;
  if (mouth.y > eyeCenter.y + cropUnit * 0.22 && normalizedEyeDistance > 0.22) frontal += 0.16;
  return { box: face, eyes, mouth: lips, frontal };
}

async function detectFaces(input: Buffer, width: number, height: number): Promise<Face[]> {
  const scale = Math.min(INPUT_SIZE / width, INPUT_SIZE / height);
  const resizedWidth = Math.max(1, Math.round(width * scale));
  const resizedHeight = Math.max(1, Math.round(height * scale));
  const pixels = await sharp(input, { limitInputPixels: 100_000_000 })
    .rotate()
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extend({ right: INPUT_SIZE - resizedWidth, bottom: INPUT_SIZE - resizedHeight, background: { r: 0, g: 0, b: 0 } })
    .removeAlpha()
    .raw()
    .toBuffer();
  const plane = INPUT_SIZE * INPUT_SIZE;
  const tensorData = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index++) {
    tensorData[index] = pixels[index * 3 + 2];
    tensorData[plane + index] = pixels[index * 3 + 1];
    tensorData[plane * 2 + index] = pixels[index * 3];
  }
  const run = async () => {
    const session = await getSession();
    const outputs = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', tensorData, [1, 3, INPUT_SIZE, INPUT_SIZE]) });
    return decodeDetections(outputs, scale)
      .map(face => ({
        ...face,
        x: clamp(Math.floor(face.x), 0, width - 1),
        y: clamp(Math.floor(face.y), 0, height - 1),
        w: clamp(Math.ceil(face.w), 2, width - clamp(Math.floor(face.x), 0, width - 1)),
        h: clamp(Math.ceil(face.h), 2, height - clamp(Math.floor(face.y), 0, height - 1)),
      }))
      .filter(face => isValidFace(face, width, height));
  };
  const pending = inferenceChain.then(run, run);
  inferenceChain = pending.then(() => undefined, () => undefined);
  return pending;
}

async function loadSource(source: string, publicBaseUrl?: string): Promise<Buffer> {
  const dataMatch = source.match(/^data:image\/[^;]+;base64,(.+)$/s);
  if (dataMatch) {
    const buffer = Buffer.from(dataMatch[1], 'base64');
    if (buffer.length > MAX_SOURCE_BYTES) throw new Error('人物图片超过 25MB 限制');
    return buffer;
  }
  if (source.startsWith('/uploads/')) {
    const filename = path.basename(source.split('?')[0]);
    return fs.readFileSync(path.join(process.cwd(), 'data', 'uploads', filename));
  }
  let parsed: URL;
  try { parsed = new URL(source); } catch { throw new Error('人物图片地址无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('人物图片仅支持 HTTP(S) 或 data URL');
  if (publicBaseUrl) {
    try {
      const publicOrigin = new URL(publicBaseUrl).origin;
      if (parsed.origin === publicOrigin && parsed.pathname.startsWith('/uploads/')) {
        return fs.readFileSync(path.join(process.cwd(), 'data', 'uploads', path.basename(parsed.pathname)));
      }
    } catch { /* fetch the URL normally */ }
  }
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`人物图片下载失败（HTTP ${response.status}）`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > MAX_SOURCE_BYTES) throw new Error('人物图片超过 25MB 限制');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_SOURCE_BYTES) throw new Error('人物图片超过 25MB 限制');
  return buffer;
}

function svgLabel(text: string, width: number, height: number): Buffer {
  const escaped = text.replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[value]!));
  const fontSize = Math.max(16, Math.round(width * 0.095));
  return Buffer.from(`<svg width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><text x="50%" y="${fontSize}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="700" fill="#111827">${escaped}</text></svg>`);
}

async function renderProcessed(input: Buffer, width: number, height: number, faces: Face[], primaryIndex: number): Promise<Buffer> {
  const primary = faceRegions(faces[primaryIndex], width, height)!;
  const stripWidth = Math.max(80, Math.round(width * 0.24));
  const margin = Math.round(Math.min(stripWidth, height) * 0.04);
  const contentWidth = stripWidth - margin * 2;
  const gap = Math.max(8, Math.round(height * 0.03));
  const labelHeight = Math.max(22, Math.round(contentWidth * 0.15));
  const available = Math.max(24, height - margin * 2 - gap * 2 - labelHeight * 3);
  const eyeHalf = Math.max(2, Math.floor(primary.eyes.w / 2));
  const crops = [
    { label: 'lip close-up', box: primary.mouth },
    { label: 'eye close-up L', box: { ...primary.eyes, w: eyeHalf } },
    { label: 'eye close-up R', box: { ...primary.eyes, x: primary.eyes.x + eyeHalf, w: primary.eyes.w - eyeHalf } },
  ];
  const weights = crops.map(item => Math.max(8, contentWidth * item.box.h / Math.max(1, item.box.w)));
  const weightScale = Math.min(1, available / weights.reduce((sum, value) => sum + value, 0));
  const composites: sharp.OverlayOptions[] = [{ input, left: stripWidth, top: 0 }];
  let top = margin;
  for (let index = 0; index < crops.length; index++) {
    const item = crops[index];
    const cropHeight = Math.max(8, Math.round(weights[index] * weightScale));
    const crop = await sharp(input)
      .extract({ left: Math.round(item.box.x), top: Math.round(item.box.y), width: Math.round(item.box.w), height: Math.round(item.box.h) })
      .resize(contentWidth, cropHeight, { fit: 'contain', background: 'white' })
      .jpeg({ quality: 92 })
      .toBuffer();
    composites.push({ input: svgLabel(item.label, contentWidth, labelHeight), left: margin, top });
    composites.push({ input: crop, left: margin, top: top + labelHeight });
    top += labelHeight + cropHeight + gap;
  }
  const masks: Box[] = [primary.eyes, primary.mouth];
  faces.forEach((face, index) => {
    if (index === primaryIndex) return;
    const regions = faceRegions(face, width, height);
    if (regions) masks.push(regions.eyes, regions.mouth);
  });
  for (const mask of masks) {
    composites.push({
      input: { create: { width: Math.round(mask.w), height: Math.round(mask.h), channels: 3, background: 'white' } },
      left: stripWidth + Math.round(mask.x),
      top: Math.round(mask.y),
    });
  }
  return sharp({ create: { width: stripWidth + width, height, channels: 3, background: 'white' } })
    .composite(composites)
    .jpeg({ quality: 92 })
    .toBuffer();
}

export async function processHmFaceImage(source: string, options: {
  publicBaseUrl?: string;
  outputKey?: string;
} = {}): Promise<HmFaceProcessingResult> {
  const input = await loadSource(source, options.publicBaseUrl);
  const normalized = await sharp(input, { limitInputPixels: 100_000_000 }).rotate().jpeg({ quality: 92 }).toBuffer();
  const metadata = await sharp(normalized).metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  if (width < 2 || height < 2) throw new Error('人物图片尺寸无效');
  const faces = await detectFaces(normalized, width, height);
  let primaryIndex = -1;
  let bestScore = 0;
  faces.forEach((face, index) => {
    const regions = faceRegions(face, width, height);
    if (!regions) return;
    const score = face.w * face.h * Math.max(0.15, regions.frontal) * (isFrontal(face, width, height) ? 4 : 1);
    if (score > bestScore) { bestScore = score; primaryIndex = index; }
  });
  if (primaryIndex < 0) {
    return { source, details: { faceCount: faces.length, cutCount: 0, maskedCount: 0, width, height } };
  }
  const output = await renderProcessed(normalized, width, height, faces, primaryIndex);
  const uploadDir = path.join(process.cwd(), 'data', 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const safeKey = String(options.outputKey || crypto.randomUUID()).replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `hm_face_${safeKey}.jpg`;
  fs.writeFileSync(path.join(uploadDir, filename), output);
  const relativeUrl = `/uploads/${filename}`;
  return {
    // Keep the persisted reference compact and stable. The HM adapter reads
    // /uploads files directly and sends their bytes in multipart form.
    source: relativeUrl,
    details: {
      faceCount: faces.length,
      cutCount: 1,
      maskedCount: Math.max(0, faces.length - 1),
      width: width + Math.max(80, Math.round(width * 0.24)),
      height,
    },
  };
}

export async function processHmFaceImages(sources: string[], options: {
  publicBaseUrl?: string;
  outputPrefix?: string;
} = {}): Promise<{ sources: string[]; details: HmFaceProcessingDetails[] }> {
  const results: HmFaceProcessingResult[] = [];
  for (let index = 0; index < sources.length; index++) {
    results.push(await processHmFaceImage(sources[index], {
      publicBaseUrl: options.publicBaseUrl,
      outputKey: `${options.outputPrefix || crypto.randomUUID()}_${index + 1}`,
    }));
  }
  return { sources: results.map(result => result.source), details: results.map(result => result.details) };
}
