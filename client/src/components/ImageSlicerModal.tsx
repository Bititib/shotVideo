import React, { useState, useEffect, useRef } from 'react';
import { X, Grid, Sliders, Scissors } from 'lucide-react';

interface ImageSlicerModalProps {
  imageUrl: string;
  onClose: () => void;
  onConfirm: (slicedImages: string[]) => void;
}

export default function ImageSlicerModal({ imageUrl, onClose, onConfirm }: ImageSlicerModalProps) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [loading, setLoading] = useState(false);
  const imageRef = useRef<HTMLImageElement>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      setDimensions({ width: img.width, height: img.height });
    };
    img.src = imageUrl;
  }, [imageUrl]);

  const presets = [
    { name: '九宫格 (3x3)', r: 3, c: 3 },
    { name: '四宫格 (2x2)', r: 2, c: 2 },
    { name: '竖排分镜 (3x1)', r: 3, c: 1 },
    { name: '横排分镜 (1x3)', r: 1, c: 3 },
    { name: '双格横排 (1x2)', r: 1, c: 2 },
    { name: '双格竖排 (2x1)', r: 2, c: 1 },
  ];

  const handleSlice = () => {
    setLoading(true);
    // 给微小的延迟让 Loading 动画能够渲染
    setTimeout(() => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const sliced: string[] = [];
          const cellWidth = img.width / cols;
          const cellHeight = img.height / rows;

          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const canvas = document.createElement('canvas');
              canvas.width = cellWidth;
              canvas.height = cellHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(
                  img,
                  c * cellWidth,
                  r * cellHeight,
                  cellWidth,
                  cellHeight,
                  0,
                  0,
                  cellWidth,
                  cellHeight
                );
                sliced.push(canvas.toDataURL('image/jpeg', 0.85));
              }
            }
          }
          onConfirm(sliced);
        } catch (err) {
          console.error('Slice failed:', err);
          alert('图片切分失败，可能是图片跨域限制，请尝试本地重新上传');
        } finally {
          setLoading(false);
        }
      };
      img.onerror = () => {
        alert('加载图片失败');
        setLoading(false);
      };
      img.src = imageUrl;
    }, 100);
  };

  return (
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/80 backdrop-blur-md p-4">
      <div className="w-full max-w-4xl bg-zinc-950 border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col md:flex-row max-h-[90vh]">
        {/* 左侧：图片预览 + 网格线 */}
        <div className="flex-1 bg-black p-6 flex items-center justify-center relative min-h-[300px] md:min-h-[450px] overflow-hidden border-b md:border-b-0 md:border-r border-white/5">
          <div className="relative max-w-full max-h-[60vh] md:max-h-[75vh] flex items-center justify-center">
            <img
              ref={imageRef}
              src={imageUrl}
              alt="Slice Preview"
              className="max-w-full max-h-[60vh] md:max-h-[75vh] object-contain rounded-lg pointer-events-none"
            />
            {/* 叠加上方的虚线网格 */}
            {imageRef.current && (
              <div
                className="absolute pointer-events-none"
                style={{
                  width: imageRef.current.clientWidth,
                  height: imageRef.current.clientHeight,
                  top: imageRef.current.offsetTop,
                  left: imageRef.current.offsetLeft,
                }}
              >
                {/* 绘制行线 */}
                {Array.from({ length: rows - 1 }).map((_, i) => (
                  <div
                    key={`row-${i}`}
                    className="absolute w-full border-t border-dashed border-yellow-400/80 drop-shadow-[0_0_2px_rgba(0,0,0,0.8)]"
                    style={{ top: `${((i + 1) / rows) * 100}%` }}
                  />
                ))}
                {/* 绘制列线 */}
                {Array.from({ length: cols - 1 }).map((_, i) => (
                  <div
                    key={`col-${i}`}
                    className="absolute h-full border-l border-dashed border-yellow-400/80 drop-shadow-[0_0_2px_rgba(0,0,0,0.8)]"
                    style={{ left: `${((i + 1) / cols) * 100}%` }}
                  />
                ))}
                {/* 网格格数角标 */}
                <div className="absolute bottom-2 right-2 bg-black/80 backdrop-blur border border-white/10 text-[10px] text-yellow-400 font-mono px-2 py-1 rounded-md">
                  {cols} 列 x {rows} 行 ({cols * rows} 个分镜)
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：操作面板 */}
        <div className="w-full md:w-[320px] shrink-0 p-6 flex flex-col justify-between bg-zinc-900/40">
          <div>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Scissors className="w-4 h-4 text-indigo-400" /> 分镜拼图智能切分
              </h3>
              <button onClick={onClose} className="text-zinc-500 hover:text-white transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 mb-5 leading-relaxed">
              视频生成模型需要连贯且清晰的单场景镜头。通过本工具，你可以直接将多格拼图切分成多张独立的参考图，以保证生成质量。
            </p>

            {/* 预设布局 */}
            <div className="mb-6">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Grid className="w-3.5 h-3.5 text-zinc-500" /> 预设网格布局
              </span>
              <div className="grid grid-cols-2 gap-2">
                {presets.map(p => (
                  <button
                    key={p.name}
                    onClick={() => { setRows(p.r); setCols(p.c); }}
                    className={`px-3 py-2 rounded-xl text-left text-xs font-medium border transition-all ${
                      rows === p.r && cols === p.c
                        ? 'bg-indigo-500/10 border-indigo-500/50 text-indigo-300'
                        : 'bg-white/[0.02] border-white/5 text-zinc-400 hover:bg-white/5 hover:text-zinc-200'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义调整 */}
            <div className="space-y-4 mb-6 border-t border-white/5 pt-4">
              <span className="block text-[11px] font-semibold text-zinc-500 uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-zinc-500" /> 自定义网格数量
              </span>
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
                  <span>行数 (Row): {rows}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="6"
                  value={rows}
                  onChange={e => setRows(parseInt(e.target.value))}
                  className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
                  <span>列数 (Column): {cols}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="6"
                  value={cols}
                  onChange={e => setCols(parseInt(e.target.value))}
                  className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                />
              </div>
            </div>

            {dimensions.width > 0 && (
              <div className="text-[10px] text-zinc-500 bg-white/[0.02] border border-white/5 p-3 rounded-xl font-mono space-y-1">
                <p>原始分辨率: {dimensions.width} x {dimensions.height}</p>
                <p>单图分辨率: {Math.round(dimensions.width / cols)} x {Math.round(dimensions.height / rows)}</p>
              </div>
            )}
          </div>

          <div className="flex gap-3 mt-6 border-t border-white/5 pt-4">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 bg-white/5 hover:bg-white/10 rounded-xl text-xs text-zinc-300 transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSlice}
              disabled={loading || (rows === 1 && cols === 1)}
              className="flex-1 py-2.5 bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500 text-xs font-semibold text-white rounded-xl transition-all disabled:opacity-40"
            >
              {loading ? '处理中...' : '确认切分'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
