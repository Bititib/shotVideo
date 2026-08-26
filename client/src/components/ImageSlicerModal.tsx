import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-[#302721]/65 backdrop-blur-sm p-4">
      <div className="w-full max-w-4xl bg-[#fffaf2] border border-[#d9bea0] rounded-2xl overflow-hidden shadow-[0_28px_80px_rgba(57,39,27,0.28)] flex flex-col md:flex-row max-h-[90vh]">
        {/* 左侧：图片预览 + 网格线 */}
        <div className="flex-1 bg-[#f7eee3] p-6 flex items-center justify-center relative min-h-[300px] md:min-h-[450px] overflow-hidden border-b md:border-b-0 md:border-r border-[#dfc9ad]">
          <div className="relative max-w-full max-h-[60vh] md:max-h-[75vh] flex items-center justify-center">
            <img
              ref={imageRef}
              src={imageUrl}
              alt="Slice Preview"
              className="max-w-full max-h-[60vh] md:max-h-[75vh] object-contain rounded-lg pointer-events-none shadow-[0_12px_32px_rgba(72,48,31,0.18)] ring-1 ring-[#b99572]/30"
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
                    className="absolute w-full border-t border-dashed border-[#c2613d] drop-shadow-[0_0_2px_rgba(255,250,242,0.9)]"
                    style={{ top: `${((i + 1) / rows) * 100}%` }}
                  />
                ))}
                {/* 绘制列线 */}
                {Array.from({ length: cols - 1 }).map((_, i) => (
                  <div
                    key={`col-${i}`}
                    className="absolute h-full border-l border-dashed border-[#c2613d] drop-shadow-[0_0_2px_rgba(255,250,242,0.9)]"
                    style={{ left: `${((i + 1) / cols) * 100}%` }}
                  />
                ))}
                {/* 网格格数角标 */}
                <div className="absolute bottom-2 right-2 bg-[#4e3428]/90 backdrop-blur border border-[#f2d9bd]/40 text-[10px] text-[#ffe4c5] font-mono px-2 py-1 rounded-md shadow-sm">
                  {cols} 列 x {rows} 行 ({cols * rows} 个分镜)
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 右侧：操作面板 */}
        <div className="w-full md:w-[320px] shrink-0 p-6 flex flex-col justify-between bg-[#fbf3e8]">
          <div>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-sm font-semibold text-[#4c3328] flex items-center gap-2">
                <Scissors className="w-4 h-4 text-[#a65332]" /> 分镜拼图智能切分
              </h3>
              <button onClick={onClose} aria-label="关闭" className="rounded-lg p-1 text-[#9a7a65] hover:bg-[#ead8c4] hover:text-[#6b412f] transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-[#806858] mb-5 leading-relaxed">
              视频生成模型需要连贯且清晰的单场景镜头。通过本工具，你可以直接将多格拼图切分成多张独立的参考图，以保证生成质量。
            </p>

            {/* 预设布局 */}
            <div className="mb-6">
              <span className="block text-[11px] font-semibold text-[#8a6e5a] uppercase tracking-wider mb-2 flex items-center gap-1.5">
                <Grid className="w-3.5 h-3.5 text-[#b45b38]" /> 预设网格布局
              </span>
              <div className="grid grid-cols-2 gap-2">
                {presets.map(p => (
                  <button
                    key={p.name}
                    onClick={() => { setRows(p.r); setCols(p.c); }}
                    className={`px-3 py-2 rounded-xl text-left text-xs font-medium border transition-all ${
                      rows === p.r && cols === p.c
                        ? 'bg-[#ead1b8] border-[#b65d39] text-[#783f2a] shadow-[0_4px_12px_rgba(151,77,47,0.12)]'
                        : 'bg-[#fffaf2] border-[#dec5a7] text-[#684f40] hover:bg-[#f3e4d3] hover:border-[#c99d78]'
                    }`}
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            </div>

            {/* 自定义调整 */}
            <div className="space-y-4 mb-6 border-t border-[#dfc9ad] pt-4">
              <span className="block text-[11px] font-semibold text-[#8a6e5a] uppercase tracking-wider mb-1 flex items-center gap-1.5">
                <Sliders className="w-3.5 h-3.5 text-[#b45b38]" /> 自定义网格数量
              </span>
              <div>
                <div className="flex justify-between text-xs text-[#765d4d] mb-1.5">
                  <span>行数 (Row): {rows}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="6"
                  value={rows}
                  onChange={e => setRows(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-[#dfc9ad] rounded-lg appearance-none cursor-pointer accent-[#a65332]"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs text-[#765d4d] mb-1.5">
                  <span>列数 (Column): {cols}</span>
                </div>
                <input
                  type="range"
                  min="1"
                  max="6"
                  value={cols}
                  onChange={e => setCols(parseInt(e.target.value))}
                  className="w-full h-1.5 bg-[#dfc9ad] rounded-lg appearance-none cursor-pointer accent-[#a65332]"
                />
              </div>
            </div>

            {dimensions.width > 0 && (
              <div className="text-[10px] text-[#806858] bg-[#fffaf2] border border-[#dec5a7] p-3 rounded-xl font-mono space-y-1 shadow-sm">
                <p>原始分辨率: {dimensions.width} x {dimensions.height}</p>
                <p>单图分辨率: {Math.round(dimensions.width / cols)} x {Math.round(dimensions.height / rows)}</p>
              </div>
            )}
          </div>

          <div className="flex gap-3 mt-6 border-t border-[#dfc9ad] pt-4">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 bg-[#fffaf2] hover:bg-[#efe0cf] border border-[#dec5a7] rounded-xl text-xs font-medium text-[#684f40] transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleSlice}
              disabled={loading || (rows === 1 && cols === 1)}
              className="flex-1 py-2.5 bg-[#a64f30] hover:bg-[#8f4027] border border-[#8f4027] text-xs font-semibold text-white rounded-xl shadow-[0_6px_16px_rgba(145,65,39,0.2)] transition-all disabled:opacity-40 disabled:shadow-none"
            >
              {loading ? '处理中...' : '确认切分'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
