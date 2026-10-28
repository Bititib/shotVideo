import { generationProblemSummary } from '../../../../shared/generationMessages';
import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Megaphone, UploadCloud, RefreshCw, Wand2, X, Plus, ShoppingCart, Tag, Download, Image as ImageIcon, FileText, Pencil, Check, Copy, Save } from 'lucide-react';
import { analysisApi } from '../../api/analysis';
import { contentApi } from '../../api/content';
import { ResultSection, CopyButton, LoadingOverlay } from '../../components/UIComponents';
import CopywritingDetail from '../../components/CopywritingDetail';
import ModelSelector from '../../components/ModelSelector';
import { useAuthGuard } from '../../hooks/useAuthGuard';
import { isSupportedImageFile, MOBILE_IMAGE_ACCEPT, normalizeImageFile } from '../../utils/imageNormalization';
import { copywritingLanguages, copywritingPlatforms, defaultCopywritingOptions, formatProductDetail, isProductDetailCopy, parseCopywritingOptions, type CopywritingOptions, type ProductDetailCopy } from '../../../../shared/copywriting';
import './CopywritingPage.css';

export default function CopywritingPage() {
  const guard = useAuthGuard();
  const [searchParams, setSearchParams] = useSearchParams();
  const historyId = searchParams.get('contentId');
  const [options, setOptions] = useState<CopywritingOptions>({ ...defaultCopywritingOptions, mode: 'detail' });
  const [resultOptions, setResultOptions] = useState<CopywritingOptions>({ ...defaultCopywritingOptions, mode: 'detail' });
  const [files, setFiles] = useState<File[]>([]);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const uploadingRef = useRef(false);
  const previewRef = useRef<string[]>([]);
  const mountedRef = useRef(true);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [exportFormat, setExportFormat] = useState<'md' | 'txt'>('md');
  const [genBg, setGenBg] = useState<Record<number, string>>({});
  const [genBgLoading, setGenBgLoading] = useState<Record<number, boolean>>({});
  const [selectedModel, setSelectedModel] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLElement>(null);
  const busy = isAnalyzing || loadingHistory || uploading;
  const detail = result?.detailPage as ProductDetailCopy | undefined;
  const visibleResult = result && (options.mode === 'detail') === Boolean(detail) ? result : null;
  const dirty = Boolean(detail && JSON.stringify(detail) !== savedSnapshot);

  useEffect(() => {
    if (busy || !visibleResult && !error) return;
    resultRef.current?.scrollTo?.({ top: 0 });
    if (window.matchMedia?.('(max-width: 1023px)').matches) resultRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [isAnalyzing, loadingHistory, error]);

  useEffect(() => { previewRef.current = previewUrls; }, [previewUrls]);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; previewRef.current.forEach(url => URL.revokeObjectURL(url)); }; }, []);
  useEffect(() => {
    if (!historyId) { setLoadingHistory(false); return; }
    const id = Number(historyId);
    if (!Number.isSafeInteger(id) || id <= 0) { setLoadingHistory(false); setError('记录 ID 无效'); return; }
    const controller = new AbortController();
    setLoadingHistory(true); setError(null);
    contentApi.getById(id, controller.signal).then(item => {
      if (controller.signal.aborted) return;
      if (item.type !== 'copywriting') throw new Error('这不是电商文案记录');
      const data = JSON.parse(item.resultText || '{}');
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.detailPage && !isProductDetailCopy(data.detailPage)) throw new Error('历史文案不完整，请重新生成');
      const metadata = typeof item.metadata === 'string' ? JSON.parse(item.metadata || '{}') : item.metadata || {};
      const stored = parseCopywritingOptions(metadata.copywritingOptions);
      stored.mode = data.detailPage ? 'detail' : 'marketing';
      setOptions(stored); setResultOptions(stored); setResult({ ...data, contentId: item.id });
      setSavedSnapshot(data.detailPage ? JSON.stringify(data.detailPage) : ''); setEditing(false); setMessage('');
    }).catch(error => { if (!controller.signal.aborted) setError(error.message || '历史文案加载失败'); })
      .finally(() => { if (!controller.signal.aborted) setLoadingHistory(false); });
    return () => controller.abort();
  }, [historyId]);

  const addFiles = async (incoming: File[]) => {
    if (uploadingRef.current || isAnalyzing || loadingHistory || saving) return;
    if (incoming.length + files.length > 10) { setError('最多上传 10 个产品素材'); return; }
    if (incoming.some(file => !isSupportedImageFile(file) && !file.type.startsWith('video/'))) { setError('请上传产品图片或视频'); return; }
    if (incoming.some(file => file.size > 150 * 1024 * 1024)) { setError('素材文件过大'); return; }
    uploadingRef.current = true; setUploading(true); setError(null);
    try {
      const prepared = await Promise.all(incoming.map(async file => isSupportedImageFile(file)
        ? (await normalizeImageFile(file, { maxDimension: 2048, quality: 0.9, outputType: 'image/jpeg', maxInputBytes: 20 * 1024 * 1024 })).file : file));
      if (!mountedRef.current) return;
      setFiles(previous => [...previous, ...prepared]);
      setPreviewUrls(previous => [...previous, ...prepared.map(file => URL.createObjectURL(file))]);
    } catch (error: any) { setError(error.message || '图片读取失败'); }
    finally { uploadingRef.current = false; if (mountedRef.current) setUploading(false); }
  };
  const removeFile = (index: number) => {
    URL.revokeObjectURL(previewUrls[index]);
    setFiles(previous => previous.filter((_, i) => i !== index)); setPreviewUrls(previous => previous.filter((_, i) => i !== index));
  };
  const handleAnalyze = async () => {
    if (!files.length || busy || saving || !guard()) return;
    let requestOptions: CopywritingOptions;
    try { requestOptions = parseCopywritingOptions(options); } catch (error: any) { setError(error.message); return; }
    if (historyId) setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete('contentId'); return next; }, { replace: true });
    setIsAnalyzing(true); setError(null); setMessage('');
    try {
      const data = await analysisApi.analyzeCopywriting(files, selectedModel || undefined, requestOptions);
      if (requestOptions.mode === 'detail' && !isProductDetailCopy(data?.detailPage)) throw new Error('返回的详情页文案不完整，请重试');
      setResult(data); setResultOptions(requestOptions); setEditing(false); setGenBg({}); setGenBgLoading({});
      setSavedSnapshot(data.detailPage ? JSON.stringify(data.detailPage) : '');
      setMessage(data.contentId ? '已存入生成记录' : '记录未保存，请先复制或导出文案');
    } catch (error: any) { setError(error.message || '文案生成失败'); }
    finally { setIsAnalyzing(false); }
  };
  const handleSave = async () => {
    if (!detail || !isProductDetailCopy(detail)) { setError('请补全主标题、分屏标题及有效的文案内容'); return; }
    if (!result.contentId || saving) return;
    const snapshot = JSON.stringify(detail);
    setSaving(true); setError(null); setMessage('');
    try { await contentApi.update(result.contentId, { detailPage: detail }); setSavedSnapshot(snapshot); setMessage('修改已保存'); }
    catch (error: any) { setError(error.message || '文案保存失败'); }
    finally { setSaving(false); }
  };
  const exportDetail = () => {
    if (!detail) return;
    const blob = new Blob([formatProductDetail(detail, exportFormat, resultOptions.language)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = (detail.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 70) || '产品详情页') + '.' + exportFormat;
    document.body.appendChild(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyDetail = async () => {
    if (!detail) return;
    try { await navigator.clipboard.writeText(formatProductDetail(detail, 'txt', resultOptions.language)); setMessage('全文已复制'); }
    catch { setError('复制失败，请导出文案'); }
  };
  const handleGenerateBg = async (index: number, prompt: string) => {
    if (!guard()) return;
    setGenBgLoading(previous => ({ ...previous, [index]: true }));
    try { const data = await analysisApi.generateImage(prompt, '4:5'); setGenBg(previous => ({ ...previous, [index]: 'data:image/png;base64,' + data.imageBase64 })); }
    catch (error: any) { setError(error.message); }
    finally { setGenBgLoading(previous => ({ ...previous, [index]: false })); }
  };
  const reset = () => {
    previewUrls.forEach(url => URL.revokeObjectURL(url));
    setFiles([]); setPreviewUrls([]); setResult(null); setError(null); setMessage(''); setEditing(false); setSavedSnapshot(''); setGenBg({});
    if (historyId) setSearchParams(previous => { const next = new URLSearchParams(previous); next.delete('contentId'); return next; }, { replace: true });
  };

  return <div className="copywriting-studio">
    <aside className="cw-settings">
      <h2><Megaphone size={21} />电商文案</h2>
      <div className="cw-mode-tabs" role="tablist" aria-label="文案模式">
        {([['detail', '详情页文案'], ['marketing', '营销文案']] as const).map(([mode, label]) => <button key={mode} id={'copywriting-' + mode} type="button" role="tab" aria-controls="copywriting-inputs" tabIndex={options.mode === mode ? 0 : -1} aria-selected={options.mode === mode} disabled={busy || saving} onClick={() => setOptions(previous => ({ ...previous, mode }))} onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next = event.key === 'Home' ? 'detail' : event.key === 'End' ? 'marketing' : mode === 'detail' ? 'marketing' : 'detail';
          setOptions(previous => ({ ...previous, mode: next })); document.getElementById('copywriting-' + next)?.focus();
        }}>{label}</button>)}
      </div>
      <fieldset id="copywriting-inputs" role="tabpanel" aria-labelledby={'copywriting-' + options.mode} disabled={busy || saving}>
        <div className="cw-upload-label">产品素材<span>{files.length}/10</span></div>
        <input ref={fileRef} aria-label="上传产品素材" type="file" accept={MOBILE_IMAGE_ACCEPT + ',video/*'} multiple hidden onChange={event => { if (event.target.files) void addFiles(Array.from(event.target.files)); event.target.value = ''; }} />
        <div className="cw-upload" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void addFiles(Array.from(event.dataTransfer.files)); }}>
          {previewUrls.length ? <div className="cw-previews">
            {previewUrls.map((url, index) => <div className="cw-thumbnail" key={url}>
              {files[index]?.type.startsWith('video/') ? <video src={url} /> : <img src={url} alt={'产品素材 ' + (index + 1)} />}
              <button type="button" className="cw-remove" aria-label={'移除素材 ' + (index + 1)} onClick={() => removeFile(index)}><X size={12} /></button>
            </div>)}
            {files.length < 10 && <button type="button" className="cw-add-file" aria-label="添加产品素材" onClick={() => fileRef.current?.click()}><Plus size={20} /></button>}
          </div> : <button type="button" className="cw-upload-button" onClick={() => fileRef.current?.click()}><span className="cw-upload-empty"><UploadCloud size={26} /><span>上传产品图</span><small>支持多图或视频</small></span></button>}
        </div>
        <div className="cw-options-grid">
          <label>目标平台<select aria-label="目标平台" value={options.platform} onChange={event => setOptions(previous => ({ ...previous, platform: event.target.value as CopywritingOptions['platform'] }))}>{Object.entries(copywritingPlatforms).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>文案语言<select aria-label="文案语言" value={options.language} onChange={event => setOptions(previous => ({ ...previous, language: event.target.value as CopywritingOptions['language'] }))}>{Object.entries(copywritingLanguages).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
        <details className="cw-product-info">
          <summary>补充产品信息{options.productFacts && !options.factsConfirmed ? ' · 待核实' : '（选填）'}</summary>
          <div>
            <label>产品名称<input type="text" aria-label="产品名称" maxLength={120} value={options.productName} onChange={event => setOptions(previous => ({ ...previous, productName: event.target.value }))} placeholder="填写商品名称" /></label>
            <label>目标人群<input type="text" aria-label="目标人群" maxLength={300} value={options.audience} onChange={event => setOptions(previous => ({ ...previous, audience: event.target.value }))} placeholder="例如：通勤人群" /></label>
            <label>产品信息<textarea aria-label="已核实的产品信息" maxLength={3000} rows={4} value={options.productFacts} onChange={event => setOptions(previous => ({ ...previous, productFacts: event.target.value, factsConfirmed: false }))} placeholder="材质、尺寸、成分、使用方式等" /></label>
            {options.productFacts && <label className="cw-confirm-check"><input type="checkbox" checked={options.factsConfirmed} onChange={event => setOptions(previous => ({ ...previous, factsConfirmed: event.target.checked }))} />以上产品信息已核实</label>}
          </div>
        </details>
        <ModelSelector value={selectedModel} onChange={setSelectedModel} />
        <div className="cw-generate-actions">
          <button type="button" className="cw-primary" onClick={handleAnalyze} disabled={!files.length || busy || Boolean(options.productFacts && !options.factsConfirmed)}>{isAnalyzing || uploading ? <RefreshCw size={16} className="animate-spin" /> : <Wand2 size={16} />}{isAnalyzing ? '正在生成…' : uploading ? '正在处理…' : '生成文案'}</button>
          <button type="button" className="cw-quiet" onClick={reset}>重置</button>
        </div>
      </fieldset>
      <Link className="cw-history-link" to="/app/history?type=copywriting">生成记录 ↗</Link>
    </aside>
    <main className="cw-result" ref={resultRef}>
      <div className="cw-result-inner">
        {error && <div role="alert" className="cw-message is-error">{generationProblemSummary(error)}</div>}
        {message && !error && <div role="status" className="cw-message">{message}</div>}
        {busy ? <LoadingOverlay message={loadingHistory ? '正在加载文案…' : uploading ? '正在处理产品素材…' : '正在生成文案…'} /> : visibleResult ? detail ? <>
          <div className="cw-result-toolbar">
            <h2>详情页文案{dirty ? ' · 未保存' : ''}</h2>
            <div>
              <button type="button" className="cw-toolbar-button" disabled={saving} onClick={() => setEditing(previous => !previous)}>{editing ? <Check size={14} /> : <Pencil size={14} />}{editing ? '完成编辑' : '编辑'}</button>
              {dirty && result.contentId && <button type="button" className="cw-toolbar-button" disabled={saving} onClick={handleSave}><Save size={14} />{saving ? '保存中…' : '保存'}</button>}
              <button type="button" className="cw-toolbar-button" onClick={copyDetail}><Copy size={14} />复制全文</button>
              <select aria-label="导出格式" value={exportFormat} onChange={event => setExportFormat(event.target.value as 'md' | 'txt')}><option value="md">MD</option><option value="txt">TXT</option></select>
              <button type="button" className="cw-toolbar-button" onClick={exportDetail}><Download size={14} />导出</button>
            </div>
          </div>
          <CopywritingDetail value={detail} editing={editing && !saving} onChange={detailPage => { setResult((previous: any) => ({ ...previous, detailPage })); setMessage(''); }} />
        </> : <MarketingResult result={result} genBg={genBg} genBgLoading={genBgLoading} handleGenerateBg={handleGenerateBg} /> : <div className="cw-empty"><FileText size={44} /><p>{options.mode === 'detail' ? '上传产品图，生成整页文案' : '上传素材，生成营销文案'}</p></div>}
      </div>
    </main>
  </div>;
}

function MarketingResult({ result, genBg, genBgLoading, handleGenerateBg }: { result: any; genBg: Record<number, string>; genBgLoading: Record<number, boolean>; handleGenerateBg: (index: number, prompt: string) => void }) {
  return <div className="space-y-6">
{/* TikTok */}
            <ResultSection icon={<Tag className="w-5 h-5 text-blue-400" />} title="TikTok 爆款文案">
              <div className="space-y-4">
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Hook (黄金3秒)</p><div className="flex items-start gap-2"><p className="text-sm text-white font-medium">{result.tiktok?.hook}</p><CopyButton text={result.tiktok?.hook || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Caption</p><div className="flex items-start gap-2"><p className="text-sm text-zinc-300 whitespace-pre-wrap">{result.tiktok?.caption}</p><CopyButton text={result.tiktok?.caption || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">Hashtags</p><div className="flex flex-wrap gap-1">{result.tiktok?.hashtags?.map((h: string, i: number) => <span key={i} className="text-xs text-blue-400">{h}</span>)}</div></div>
              </div>
            </ResultSection>

            {/* Amazon */}
            <ResultSection icon={<ShoppingCart className="w-5 h-5 text-orange-400" />} title="Amazon Listing">
              <div className="space-y-4">
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">SEO 标题</p><div className="flex items-start gap-2"><p className="text-sm text-white font-medium">{result.amazon?.title}</p><CopyButton text={result.amazon?.title || ''} /></div></div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">五点卖点</p>{result.amazon?.bulletPoints?.map((b: string, i: number) => <p key={i} className="text-xs text-zinc-300 flex items-start gap-2 mt-1"><span className="text-orange-400">•</span>{b}</p>)}</div>
                <div><p className="text-[10px] text-zinc-500 uppercase tracking-wider mb-1">产品描述</p><p className="text-xs text-zinc-300 whitespace-pre-wrap">{result.amazon?.productDescription}</p></div>
              </div>
            </ResultSection>

            {/* A+ Content */}
            <ResultSection icon={<ImageIcon className="w-5 h-5 text-purple-400" />} title="A+ 详情页策划">
              <div className="space-y-4">
                {result.detailPageImages?.map((img: any, i: number) => (
                  <div key={i} className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-zinc-300">{i + 1}. {img.imageType}</span>
                      <button onClick={() => handleGenerateBg(i, img.prompt)} disabled={genBgLoading[i]} className="text-[10px] px-3 py-1 bg-purple-500/20 text-purple-400 rounded-lg hover:bg-purple-500/30 disabled:opacity-50">
                        {genBgLoading[i] ? <RefreshCw className="w-3 h-3 animate-spin inline" /> : 'AI 生成底图'}
                      </button>
                    </div>
                    <p className="text-xs text-zinc-400 mb-2">{img.description}</p>
                    {img.textOverlay?.length > 0 && (
                      <div className="mb-2"><p className="text-[10px] text-zinc-500 mb-1">文案覆盖:</p>{img.textOverlay.map((t: string, j: number) => <p key={j} className="text-xs text-zinc-300">• {t}</p>)}</div>
                    )}
                    <div className="flex items-start gap-2"><p className="text-[10px] text-zinc-500 flex-1 break-all">Prompt: {img.prompt}</p><CopyButton text={img.prompt} /></div>
                    {genBg[i] && <img src={genBg[i]} className="mt-3 rounded-lg max-h-60 object-contain" />}
                  </div>
                ))}
              </div>
            </ResultSection>
  </div>;
}
