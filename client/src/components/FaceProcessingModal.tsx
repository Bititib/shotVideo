import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, ScanFace, X } from 'lucide-react';
import { processFaceImage, type FaceProcessingDetails } from '../utils/faceProcessing';

interface FaceProcessingModalProps {
  imageUrl: string;
  onClose: () => void;
  onConfirm: (processedUrl: string, details: FaceProcessingDetails) => void;
}

export default function FaceProcessingModal({ imageUrl, onClose, onConfirm }: FaceProcessingModalProps) {
  const [processedUrl, setProcessedUrl] = useState('');
  const [details, setDetails] = useState<FaceProcessingDetails | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError('');
    void processFaceImage(imageUrl, controller.signal)
      .then(result => {
        setProcessedUrl(result.dataUrl);
        setDetails(result.details);
      })
      .catch((reason: any) => {
        if (reason?.name !== 'AbortError') setError(reason?.message || '人脸处理失败');
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [imageUrl]);

  const close = () => {
    controllerRef.current?.abort();
    onClose();
  };

  return createPortal(
    <div className="fixed inset-0 z-[1250] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="face-processing-title" className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <h3 id="face-processing-title" className="flex items-center gap-2 text-sm font-semibold text-white"><ScanFace className="h-4 w-4 text-emerald-400" />本地人脸拆分</h3>
            <p className="mt-1 text-[11px] text-zinc-500">图片只在当前浏览器中处理，不会为此步骤上传到服务器。</p>
          </div>
          <button type="button" onClick={close} aria-label="关闭" className="rounded-lg p-2 text-zinc-500 hover:bg-white/5 hover:text-white"><X className="h-4 w-4" /></button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-px overflow-y-auto bg-white/10 md:grid-cols-2">
          <div className="flex min-h-[280px] flex-col bg-zinc-950 p-4">
            <span className="mb-3 text-xs font-medium text-zinc-400">处理前</span>
            <div className="flex flex-1 items-center justify-center overflow-hidden rounded-xl bg-black"><img src={imageUrl} alt="处理前" className="max-h-[60vh] max-w-full object-contain" /></div>
          </div>
          <div className="flex min-h-[280px] flex-col bg-zinc-950 p-4">
            <span className="mb-3 text-xs font-medium text-zinc-400">处理后</span>
            <div className="relative flex flex-1 items-center justify-center overflow-hidden rounded-xl bg-black">
              {processedUrl && <img src={processedUrl} alt="处理后" className="max-h-[60vh] max-w-full object-contain" />}
              {loading && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/80 text-sm text-zinc-300"><Loader2 className="h-7 w-7 animate-spin text-emerald-400" />正在加载模型并检测人脸…</div>}
              {error && <div className="px-6 text-center text-sm text-red-400">{error}</div>}
            </div>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <p className="text-xs text-zinc-500">
            {details ? `检测 ${details.faceCount} 张人脸 · 提取 ${details.cutCount} 张 · 遮挡 ${details.maskedCount} 张 · 输出 ${details.width}×${details.height}` : '首次使用需要加载约 20MB 的本地模型资源。'}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={close} className="rounded-xl border border-white/10 px-4 py-2 text-xs text-zinc-300 hover:bg-white/5">取消</button>
            <button type="button" disabled={!processedUrl || !details || loading} onClick={() => details && onConfirm(processedUrl, details)} className="flex items-center gap-1.5 rounded-xl bg-emerald-600 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"><Check className="h-3.5 w-3.5" />使用处理结果</button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
