import { useEffect, useCallback, useState, useRef, type RefObject } from 'react';

/**
 * 处理图片的拖拽上传和 Ctrl+V 粘贴上传
 * @param onFiles - 接收 FileList 的回调（复用已有的 handleFileSelect）
 * @param containerRef - 拖拽区域的 DOM ref，不传则监听整个 document
 */
export function useImageDropPaste(
  onFiles: (files: FileList | null) => void,
  containerRef?: RefObject<HTMLElement | null>,
) {
  const [isDragging, setIsDragging] = useState(false);
  const onFilesRef = useRef(onFiles);
  
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  // ── 粘贴：Ctrl+V ──
  const handlePaste = useCallback((e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const mediaFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/') || items[i].type.startsWith('video/')) {
        const file = items[i].getAsFile();
        if (file) mediaFiles.push(file);
      }
    }
    if (mediaFiles.length > 0) {
      e.preventDefault();
      const dt = new DataTransfer();
      mediaFiles.forEach(f => dt.items.add(f));
      onFilesRef.current(dt.files);
    }
  }, []);

  // ── 拖拽 ──
  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    if (e.relatedTarget === null || (e.target as HTMLElement).nodeName === 'HTML') {
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    const files = e.dataTransfer?.files;
    if (files && files.length > 0) {
      // 保留图片和视频文件
      const dt = new DataTransfer();
      for (let i = 0; i < files.length; i++) {
        if (files[i].type.startsWith('image/') || files[i].type.startsWith('video/')) {
          dt.items.add(files[i]);
        }
      }
      if (dt.files.length > 0) onFilesRef.current(dt.files);
    }
  }, []);

  useEffect(() => {
    const target = containerRef?.current || document;
    target.addEventListener('paste', handlePaste as EventListener);
    target.addEventListener('dragover', handleDragOver as EventListener);
    target.addEventListener('dragenter', handleDragEnter as EventListener);
    target.addEventListener('dragleave', handleDragLeave as EventListener);
    target.addEventListener('drop', handleDrop as EventListener);
    return () => {
      target.removeEventListener('paste', handlePaste as EventListener);
      target.removeEventListener('dragover', handleDragOver as EventListener);
      target.removeEventListener('dragenter', handleDragEnter as EventListener);
      target.removeEventListener('dragleave', handleDragLeave as EventListener);
      target.removeEventListener('drop', handleDrop as EventListener);
    };
  }, [handlePaste, handleDragOver, handleDragEnter, handleDragLeave, handleDrop, containerRef]);
  
  return { isDragging };
}
