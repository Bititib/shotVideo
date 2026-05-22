import { useEffect, useCallback, type RefObject } from 'react';

/**
 * 处理图片的拖拽上传和 Ctrl+V 粘贴上传
 * @param onFiles - 接收 FileList 的回调（复用已有的 handleFileSelect）
 * @param containerRef - 拖拽区域的 DOM ref，不传则监听整个 document
 */
export function useImageDropPaste(
  onFiles: (files: FileList | null) => void,
  containerRef?: RefObject<HTMLElement | null>,
) {
  // ── 粘贴：Ctrl+V ──
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        const file = items[i].getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      imageFiles.forEach(f => dt.items.add(f));
      onFiles(dt.files);
    }
  }, [onFiles]);

  // ── 拖拽 ──
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      // 只保留图片文件
      const dt = new DataTransfer();
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/')) dt.items.add(files[i]);
      }
      if (dt.files.length > 0) onFiles(dt.files);
    }
  }, [onFiles]);

  useEffect(() => {
    const target = containerRef?.current || document;
    target.addEventListener('paste', handlePaste as EventListener);
    target.addEventListener('dragover', handleDragOver as EventListener);
    target.addEventListener('drop', handleDrop as EventListener);
    return () => {
      target.removeEventListener('paste', handlePaste as EventListener);
      target.removeEventListener('dragover', handleDragOver as EventListener);
      target.removeEventListener('drop', handleDrop as EventListener);
    };
  }, [handlePaste, handleDragOver, handleDrop, containerRef]);
}
