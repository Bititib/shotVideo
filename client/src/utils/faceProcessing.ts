export interface FaceProcessingDetails {
  faceCount: number;
  cutCount: number;
  maskedCount: number;
  width: number;
  height: number;
}

interface FaceProcessorResult {
  blob: Blob;
  mimeType: string;
  details: FaceProcessingDetails;
}

interface FaceProcessor {
  process(
    material: { blob: Blob; name: string; slot: number },
    context: { signal: AbortSignal },
  ): Promise<FaceProcessorResult>;
}

type ExtensionFactory = (runtime: {
  resolveAsset(path: string): string;
}) => {
  contributes?: { materialProcessors?: FaceProcessor[] };
};

declare global {
  interface Window {
    __MOFANG_REGISTER__?: (factory: ExtensionFactory) => void;
    __faceProcessingFactory?: ExtensionFactory;
    __faceProcessor?: FaceProcessor;
  }
}

const SCRIPT_ID = 'face-processing-runtime';
const SCRIPT_URL = '/face-processing/face-processing.js';
const ASSET_ROOT = '/face-processing/assets/';
let processorPromise: Promise<FaceProcessor> | null = null;

function loadProcessor(): Promise<FaceProcessor> {
  if (window.__faceProcessor) return Promise.resolve(window.__faceProcessor);
  if (processorPromise) return processorPromise;

  processorPromise = new Promise<FaceProcessor>((resolve, reject) => {
    const finish = () => {
      const factory = window.__faceProcessingFactory;
      if (!factory) {
        reject(new Error('人脸处理组件注册失败'));
        return;
      }
      try {
        const extension = factory({
          resolveAsset: path => `${ASSET_ROOT}${path}`,
        });
        const processor = extension.contributes?.materialProcessors?.[0];
        if (!processor) throw new Error('未找到人脸处理器');
        window.__faceProcessor = processor;
        resolve(processor);
      } catch (error) {
        reject(error);
      }
    };

    if (window.__faceProcessingFactory) {
      finish();
      return;
    }

    const previousRegister = window.__MOFANG_REGISTER__;
    window.__MOFANG_REGISTER__ = factory => {
      window.__faceProcessingFactory = factory;
      previousRegister?.(factory);
    };

    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', finish, { once: true });
      existing.addEventListener('error', () => reject(new Error('人脸处理组件加载失败')), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = finish;
    script.onerror = () => reject(new Error('人脸处理组件加载失败'));
    document.head.appendChild(script);
  }).catch(error => {
    processorPromise = null;
    throw error;
  });

  return processorPromise;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('人脸处理结果编码失败'));
    reader.readAsDataURL(blob);
  });
}

export async function processFaceImage(
  imageUrl: string,
  signal: AbortSignal,
): Promise<{ dataUrl: string; details: FaceProcessingDetails }> {
  const response = await fetch(imageUrl, { signal });
  if (!response.ok) throw new Error('无法读取参考图片');
  const source = await response.blob();
  const processor = await loadProcessor();
  if (signal.aborted) throw new DOMException('已取消人脸处理', 'AbortError');
  const result = await processor.process(
    { blob: source, name: 'reference-image.jpg', slot: 0 },
    { signal },
  );
  return { dataUrl: await blobToDataUrl(result.blob), details: result.details };
}
