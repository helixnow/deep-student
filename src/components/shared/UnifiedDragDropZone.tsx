import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { invoke } from '@tauri-apps/api/core';
import { guardedListen } from '../../utils/guardedListen';
import { getErrorMessage } from '../../utils/errorUtils';
import { showGlobalNotification } from '../UnifiedNotification';
import { ensureGlobalDragHandlers, markNativeDrop, isNativeDropRecent } from '../../hooks/useTauriDragAndDrop';
import { getAttachmentSizeLimitForFile } from '@/features/chat/core/constants';

/**
 * 扩展名到 MIME 类型的统一映射表
 * 
 * ★ SSOT 文档：docs/design/file-format-registry.md
 * 与后端 src-tauri/src/vfs/repos/attachment_repo.rs 的 infer_extension 保持一致。
 * 当 file.type 为空时，通过扩展名推断 MIME 类型。
 * 修改格式支持时需同步更新文档和其他实现位置。
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  // 图片格式
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  bmp: 'image/bmp',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  
  // PDF
  pdf: 'application/pdf',
  
  // Office 文档
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  
  // 文本格式
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  
  // 电子书与富文本
  epub: 'application/epub+zip',
  rtf: 'application/rtf',
  
  // 压缩格式
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  rar: 'application/x-rar-compressed',
  '7z': 'application/x-7z-compressed',
  
  // 音频格式
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
  opus: 'audio/opus',
  
  // 视频格式
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  m4v: 'video/x-m4v',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
};

// 调试事件发射器
const emitDebugEvent = (
  zoneId: string,
  stage: string,
  level: 'debug' | 'info' | 'warning' | 'error',
  message: string,
  details?: Record<string, any>
) => {
  try {
    const event = new CustomEvent('unified-drag-drop-debug', {
      detail: {
        zoneId,
        stage,
        level,
        message,
        details,
      },
    });
    window.dispatchEvent(event);
  } catch (e: unknown) {
    console.warn('[UnifiedDragDropZone] Debug event emit failed:', e);
  }
};

export interface FileTypeDefinition {
  extensions: string[];
  mimeTypes: string[];
  description: string;
}

/**
 * 文件类型定义
 * 
 * ★ 2026-01-31 统一：各入口文件类型白名单
 * 
 * 设计原则：
 * - IMAGE：支持常见图片格式，包括 HEIC/HEIF（iPhone 照片格式）
 * - DOCUMENT：文档类型，所有入口通用
 * - ARCHIVE：压缩包仅定义但默认不启用（无解析/预览支持）
 * 
 * HEIC/HEIF 说明：
 * - 浏览器原生支持有限，但 Tauri 后端可进行格式转换
 * - 对于 OCR、试卷识别等场景，HEIC 是常见的 iPhone 照片格式
 * - 前端预览可能需要后端转换为 JPEG/PNG
 * 
 * 入口差异说明：
 * - 教材导入（LearningHubSidebar）：仅 DOCUMENT，不包含图片
 * - Chat 附件（constants.ts）：IMAGE + DOCUMENT
 * - 通用拖拽（此组件）：默认 IMAGE + DOCUMENT，可配置
 */
export const FILE_TYPES: Record<string, FileTypeDefinition> = {
  IMAGE: {
    // ★ 2026-01-31 统一：添加 heic/heif 支持
    // 原因：iPhone 照片默认使用 HEIC 格式，OCR/试卷识别场景常见
    extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'heic', 'heif'],
    mimeTypes: [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/bmp',
      'image/webp',
      'image/svg+xml',
      'image/heic',
      'image/heif',
    ],
    description: 'Image',
  },
  DOCUMENT: {
    extensions: [
      'pdf', 'docx', 'txt', 'md', 'csv', 'json', 'xml', 'html', 'htm', 'xlsx', 'xls', 'xlsb', 'ods',
      'pptx',  // PowerPoint
      'epub',  // 电子书
      'rtf',   // 富文本
      // 注：.doc（旧版 Word）不支持，无纯 Rust 解析库
    ],
    mimeTypes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
      'text/markdown',
      'text/csv',
      'application/json',
      'text/html',
      'application/xml',
      'text/xml',  // XML (alternative)
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation', // pptx
      'application/epub+zip',  // epub
      'application/rtf',       // rtf
      'text/rtf',              // rtf (alternative)
    ],
    description: 'Document',
  },
  AUDIO: {
    extensions: ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'],
    mimeTypes: ['audio/*'],
    description: 'Audio',
  },
  VIDEO: {
    extensions: ['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'],
    mimeTypes: ['video/*'],
    description: 'Video',
  },
  ARCHIVE: {
    extensions: ['zip', 'tar', 'gz', 'rar', '7z'],
    mimeTypes: [
      'application/zip',
      'application/x-tar',
      'application/gzip',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
    ],
    description: 'Archive',
  },
  ALL: {
    extensions: ['*'],
    mimeTypes: ['*/*'],
    description: 'All Files',
  },
};

/**
 * 浏览器上传路径（点击选择 / dataTransfer 拖拽 / Tauri 原生拖拽）的默认单文件上限（50MB）。
 *
 * ★ #62/ATT-09：需要 50MB 兜底的入口请引用本常量，不要各自硬编码，
 * 超限提示文案也应由传入的 maxFileSize 派生；聊天附件入口会显式传入
 * ATTACHMENT_MAX_SIZE（200MB）覆盖此默认值。
 */
export const DEFAULT_MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024;

export interface UnifiedDragDropZoneProps {
  zoneId: string;
  onFilesDropped: (files: File[]) => void | Promise<void>;
  onPathsDropped?: (paths: string[]) => void | Promise<void>;
  enabled?: boolean;
  acceptedFileTypes?: FileTypeDefinition[];
  maxFiles?: number;
  maxFileSize?: number;
  showOverlay?: boolean;
  customOverlayText?: string;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  onError?: (error: string) => void;
  onValidationError?: (error: string, rejectedFiles: string[]) => void;
  onDragStateChange?: (isDragging: boolean) => void;
}

interface DragDropPayload {
  type: 'enter' | 'leave' | 'drop' | 'over' | 'cancel';
  paths?: string[];
  position?: { x: number; y: number };
}

export const UnifiedDragDropZone: React.FC<UnifiedDragDropZoneProps> = ({
  zoneId,
  onFilesDropped,
  onPathsDropped,
  enabled = true,
  acceptedFileTypes = [FILE_TYPES.IMAGE, FILE_TYPES.DOCUMENT],
  maxFiles = 10,
  maxFileSize = DEFAULT_MAX_UPLOAD_FILE_SIZE,
  showOverlay = true,
  customOverlayText,
  className = '',
  style,
  children,
  onError,
  onValidationError,
  onDragStateChange,
}) => {
  const { t } = useTranslation(['drag_drop']);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const onFilesDroppedRef = useRef(onFilesDropped);
  const onPathsDroppedRef = useRef(onPathsDropped);
  const onErrorRef = useRef(onError);
  const onValidationErrorRef = useRef(onValidationError);
  
  // 防抖: 记录最后处理的路径和时间戳,避免多个事件监听器同时触发导致重复处理
  const lastProcessedRef = useRef<{ paths: string[]; timestamp: number } | null>(null);

  useEffect(() => {
    onFilesDroppedRef.current = onFilesDropped;
    onPathsDroppedRef.current = onPathsDropped;
    onErrorRef.current = onError;
    onValidationErrorRef.current = onValidationError;
  }, [onFilesDropped, onPathsDropped, onError, onValidationError]);

  const updateDragState = useCallback(
    (dragging: boolean) => {
      setIsDragging(dragging);
      onDragStateChange?.(dragging);
      emitDebugEvent(zoneId, dragging ? 'drag_enter' : 'drag_leave', 'debug', dragging ? '拖拽进入区域' : '拖拽离开区域', {
        enabled,
      });
    },
    [onDragStateChange, zoneId, enabled]
  );

  const isDropZoneVisible = useCallback((): boolean => {
    if (!dropZoneRef.current) return false;
    const el = dropZoneRef.current;
    
    // 检查尺寸
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
    
    // 检查自身样式
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    
    // 🔥 关键修复：检查祖先容器的 opacity 和 pointer-events（页面切换机制）
    // ⚠️ 不在这里发送调试事件，避免性能问题
    let current: HTMLElement | null = el;
    while (current) {
      const computedStyle = window.getComputedStyle(current);
      
      // 检查 opacity（App.tsx 的页面切换使用 opacity: 0 隐藏）
      const opacity = parseFloat(computedStyle.opacity);
      if (opacity === 0) return false;
      
      // 检查 pointer-events（App.tsx 的页面切换使用 pointer-events: none）
      if (computedStyle.pointerEvents === 'none') return false;
      
      // 检查 z-index（App.tsx 的页面切换使用 z-index: -1）
      const zIndexValue = parseInt(computedStyle.zIndex, 10);
      if (!isNaN(zIndexValue) && zIndexValue < 0) return false;
      
      current = current.parentElement;
    }
    
    // 检查视口位置
    const rect = el.getBoundingClientRect();
    return (
      rect.top < window.innerHeight &&
      rect.bottom > 0 &&
      rect.left < window.innerWidth &&
      rect.right > 0
    );
  }, []);

  const isPointInsideDropZone = useCallback((pos?: { x: number; y: number }): boolean => {
    if (!pos || !dropZoneRef.current) return false;
    const rect = dropZoneRef.current.getBoundingClientRect();
    return pos.x >= rect.left && pos.x <= rect.right && pos.y >= rect.top && pos.y <= rect.bottom;
  }, []);

  const isFileTypeAccepted = useCallback(
    (filename: string): boolean => {
      if (acceptedFileTypes.some((t) => t.extensions.includes('*'))) return true;
      const ext = filename.split('.').pop()?.toLowerCase();
      if (!ext) return false;
      return acceptedFileTypes.some((t) => t.extensions.includes(ext));
    },
    [acceptedFileTypes]
  );

  /**
   * 根据文件名推断 MIME 类型
   * 
   * 优先使用 EXTENSION_TO_MIME 统一映射表，确保与后端一致
   * 当扩展名未在映射表中时，回退到 acceptedFileTypes 的兜底逻辑
   */
  const getMimeType = useCallback(
    (filename: string): string => {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (!ext) return 'application/octet-stream';
      
      // 优先使用统一映射表（与后端保持一致）
      const mappedMime = EXTENSION_TO_MIME[ext];
      if (mappedMime) {
        return mappedMime;
      }
      
      // 兜底：检查 acceptedFileTypes 中的第一个匹配
      for (const t of acceptedFileTypes) {
        if (t.extensions.includes(ext) && t.mimeTypes.length > 0) {
          return t.mimeTypes[0];
        }
      }
      
      return 'application/octet-stream';
    },
    [acceptedFileTypes]
  );

  const validateFileSize = useCallback(
    (size: number, fileName: string) => size <= getAttachmentSizeLimitForFile(fileName, maxFileSize),
    [maxFileSize]
  );

  const processFilePaths = useCallback(
    async (paths: string[]) => {
      const startTime = performance.now();
      // ⚠️ 可见性检查已在监听器入口完成，这里只检查是否正在处理
      if (isProcessing) return;
      
      // 🔥 防抖检查: 如果在100ms内收到相同的文件路径,跳过处理
      const now = Date.now();
      const pathsKey = JSON.stringify([...paths].sort());
      if (lastProcessedRef.current) {
        const timeDiff = now - lastProcessedRef.current.timestamp;
        const lastPathsKey = JSON.stringify([...lastProcessedRef.current.paths].sort());
        if (timeDiff < 100 && pathsKey === lastPathsKey) {
          emitDebugEvent(zoneId, 'drop_received', 'debug', `跳过重复处理 (${timeDiff.toFixed(0)}ms内的重复事件)`, {
            filePaths: paths,
            timeDiff: `${timeDiff.toFixed(0)}ms`,
          });
          return;
        }
      }
      
      // 更新最后处理记录
      lastProcessedRef.current = { paths: [...paths], timestamp: now };
      setIsProcessing(true);
      
      emitDebugEvent(zoneId, 'drop_received', 'info', `接收到 ${paths.length} 个文件路径`, { 
        filePaths: paths,
        maxFiles,
        maxFileSize: `${(maxFileSize / (1024 * 1024)).toFixed(1)}MB`,
      });
      
      try {
        const uniquePaths = [...new Set(paths)];
        
        if (uniquePaths.length > maxFiles) {
          const err = t('drag_drop:errors.too_many_files', { max: maxFiles });
          emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件数量超限: ${uniquePaths.length} > ${maxFiles}`, {
            totalFiles: uniquePaths.length,
            maxFiles,
            rejectedCount: uniquePaths.length - maxFiles,
          });
          onValidationErrorRef.current?.(err as any, uniquePaths.slice(maxFiles));
          showGlobalNotification('warning', err);
        }
        const limited = uniquePaths.slice(0, maxFiles);
        
        emitDebugEvent(zoneId, 'validation_start', 'debug', `开始验证 ${limited.length} 个文件`, {
          acceptedExtensions: acceptedFileTypes.flatMap(t => t.extensions),
        });

        const files: File[] = [];
        const rejected: string[] = [];
        const validPaths: string[] = []; // 验证通过的路径

        for (const p of limited) {
          const name = p.split(/[/\\]/).pop() || 'file';
          
          // 先验证文件类型
          if (!isFileTypeAccepted(name)) {
            const reason = `${name}: ${t('drag_drop:errors.unsupported_type')}`;
            rejected.push(reason as any);
            emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件类型不支持: ${name}`, {
              fileName: name,
              path: p,
              acceptedExtensions: acceptedFileTypes.flatMap(t => t.extensions),
            });
            continue;
          }
          
          // 🔧 使用 Tauri IPC 读取文件，避免 asset protocol 在 Windows 上对含中文/空格路径的 fetch 失败
          try {
            // 先检查文件大小（避免读入超大文件到内存）
            const fileSize = await invoke<number>('get_file_size', { path: p });
            if (!validateFileSize(fileSize, name)) {
              const sizeMB = (getAttachmentSizeLimitForFile(name, maxFileSize) / (1024 * 1024)).toFixed(1);
              const reason = `${name}: ${t('drag_drop:errors.file_too_large', { size: sizeMB })}`;
              rejected.push(reason as any);
              emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件过大: ${name}`, {
                fileName: name,
                fileSize: `${(fileSize / (1024 * 1024)).toFixed(2)}MB`,
                maxSize: `${sizeMB}MB`,
              });
              continue;
            }

            const rawBytes = await invoke<ArrayBuffer>('read_file_bytes', { path: p });
            const bytes = new Uint8Array(rawBytes);
            
            // 验证通过，添加到有效路径列表
            validPaths.push(p);
            const mime = getMimeType(name);
            files.push(new File([bytes], name, { type: mime }));
            
            emitDebugEvent(zoneId, 'file_converted', 'debug', `文件转换成功: ${name}`, {
              fileName: name,
              fileSize: `${(bytes.length / (1024 * 1024)).toFixed(2)}MB`,
              mimeType: mime,
            });
          } catch (fileError: unknown) {
            const errMsg = getErrorMessage(fileError);
            rejected.push(`${name}: ${errMsg}`);
            emitDebugEvent(zoneId, 'file_processing', 'error', `文件处理失败: ${name}`, {
              fileName: name,
              path: p,
              error: errMsg,
            });
          }
        }

        if (rejected.length) {
          const msg = t('drag_drop:errors.some_files_rejected', { count: rejected.length });
          onValidationErrorRef.current?.(msg as any, rejected);
          showGlobalNotification('warning', `${msg}\n${rejected.slice(0, 3).join('\n')}${rejected.length > 3 ? '\n...' : ''}`);
          emitDebugEvent(zoneId, 'validation_failed', 'warning', `${rejected.length} 个文件被拒绝`, {
            rejectedCount: rejected.length,
            rejectedFiles: rejected,
          });
        }
        
        // 只有验证通过的文件才调用 onPathsDropped
        if (validPaths.length > 0 && onPathsDroppedRef.current) {
          try {
            emitDebugEvent(zoneId, 'callback_invoked', 'debug', `调用 onPathsDropped (${validPaths.length} 个文件)`, {
              validPaths,
            });
            await onPathsDroppedRef.current(validPaths);
            emitDebugEvent(zoneId, 'callback_invoked', 'info', `onPathsDropped 执行成功`, {
              fileCount: validPaths.length,
            });
          } catch (e: unknown) {
            const errorMsg = getErrorMessage(e);
            emitDebugEvent(zoneId, 'callback_error', 'error', `onPathsDropped 执行失败: ${errorMsg}`, {
              error: errorMsg,
              validPaths,
            });
            console.warn(`[UnifiedDragDropZone:${zoneId}] onPathsDropped error:`, e);
          }
        }

        if (files.length) {
          emitDebugEvent(zoneId, 'callback_invoked', 'debug', `调用 onFilesDropped (${files.length} 个文件)`, {
            fileNames: files.map(f => f.name),
          });
          await onFilesDroppedRef.current(files);
          emitDebugEvent(zoneId, 'complete', 'info', `文件处理完成: ${files.length} 个成功, ${rejected.length} 个失败`, {
            successCount: files.length,
            rejectedCount: rejected.length,
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          });
        } else if (!rejected.length) {
          showGlobalNotification('info', t('drag_drop:errors.no_valid_files'));
          emitDebugEvent(zoneId, 'complete', 'warning', '没有有效文件', {
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          });
        }
      } catch (e: unknown) {
        const err = t('drag_drop:errors.processing_failed', { error: getErrorMessage(e) });
        onErrorRef.current?.(err as any);
        showGlobalNotification('error', err);
        emitDebugEvent(zoneId, 'callback_error', 'error', `处理失败: ${getErrorMessage(e)}`, {
          error: getErrorMessage(e),
          processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
        });
      } finally {
        setIsProcessing(false);
      }
    },
    [isProcessing, maxFiles, maxFileSize, isFileTypeAccepted, getMimeType, validateFileSize, t, zoneId, acceptedFileTypes]
  );

  useEffect(() => {
    if (!enabled) return;

    // 🔧 Windows WebView2 兼容：确保全局 dragover/drop 处理器已安装
    ensureGlobalDragHandlers();

    let unlisten: undefined | (() => void);
    const unlisteners: Array<() => void> = [];

    // 🔥 安全措施: 监听全局 dragend 事件,确保拖拽状态能被清除
    const handleGlobalDragEnd = () => {
      if (isDragging) {
        updateDragState(false);
        emitDebugEvent(zoneId, 'drag_leave', 'debug', '全局拖拽结束,清除状态', {
          reason: 'global_dragend',
        });
      }
    };
    document.addEventListener('dragend', handleGlobalDragEnd);
    document.addEventListener('drop', handleGlobalDragEnd);

    const setup = async () => {
      try {
        const webview = getCurrentWebview();
        unlisten = await webview.onDragDropEvent((event) => {
          // 🔥 提前静默检查可见性，不可见就直接返回，不发送任何日志
          if (!isDropZoneVisible()) return;
          
          const payload = event.payload as DragDropPayload;
          
          // 🔥 关键修复: leave/cancel/drop 事件不需要检查鼠标位置
          // leave/cancel: 离开本身就意味着鼠标已经不在区域内了
          // drop: 拖拽操作已结束，必须无条件重置拖拽状态，否则当文件被放到其他面板时本区域 isDragging 永远卡住
          const isEndEvent = payload.type === 'leave' || payload.type === 'cancel' || payload.type === 'drop';
          if (!isEndEvent && !isPointInsideDropZone(payload.position)) return;
          
          switch (payload.type) {
            case 'enter':
            case 'over':
              updateDragState(true);
              break;
            case 'leave':
            case 'cancel':
              updateDragState(false);
              break;
            case 'drop':
              updateDragState(false);
              markNativeDrop(); // 标记原生 drop 已处理
              // 只有当 drop 发生在本区域内时才处理文件
              if (isPointInsideDropZone(payload.position) && payload.paths?.length) void processFilePaths(payload.paths);
              break;
          }
        });
      } catch (e: unknown) {
        // fallback A: tauri://drag-*
        unlisteners.push(
          await guardedListen('tauri://drag-enter', () => {
            // 🔥 提前静默检查
            if (!isDropZoneVisible()) return;
            updateDragState(true);
          })
        );
        unlisteners.push(
          await guardedListen('tauri://drag-leave', () => {
            if (!isDropZoneVisible()) return;
            updateDragState(false);
          })
        );
        unlisteners.push(
          await guardedListen('tauri://drag-drop', (event: any) => {
            // 🔥 提前静默检查
            if (!isDropZoneVisible()) return;
            const paths = event?.payload?.paths;
            updateDragState(false);
            markNativeDrop(); // 标记原生 drop 已处理
            if (paths?.length) void processFilePaths(paths);
          })
        );
        // fallback B: tauri://file-drop*
        unlisteners.push(
          await guardedListen('tauri://file-drop-hover', () => {
            // 🔥 提前静默检查
            if (!isDropZoneVisible()) return;
            updateDragState(true);
          })
        );
        unlisteners.push(
          await guardedListen('tauri://file-drop-cancelled', () => {
            if (!isDropZoneVisible()) return;
            updateDragState(false);
          })
        );
        unlisteners.push(
          await guardedListen('tauri://file-drop', (event: any) => {
            // 🔥 提前静默检查
            if (!isDropZoneVisible()) return;
            const paths = Array.isArray(event?.payload) ? event.payload : event?.payload?.paths;
            updateDragState(false);
            markNativeDrop(); // 标记原生 drop 已处理
            if (paths?.length) void processFilePaths(paths);
          })
        );
      }
    };

    void setup();
    return () => {
      document.removeEventListener('dragend', handleGlobalDragEnd);
      document.removeEventListener('drop', handleGlobalDragEnd);
      try { unlisten?.(); } catch {}
      unlisteners.forEach((fn) => { try { fn(); } catch {} });
    };
  }, [enabled, isDropZoneVisible, isPointInsideDropZone, processFilePaths, updateDragState, isDragging, zoneId]);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!enabled || isProcessing) return;
    updateDragState(true);
  }, [enabled, isProcessing, updateDragState]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) updateDragState(false);
  }, [updateDragState]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (enabled && !isProcessing) e.dataTransfer.dropEffect = 'copy';
  }, [enabled, isProcessing]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    updateDragState(false);
    // 🔧 Windows 兼容：用时间戳去重替代 __TAURI_INTERNALS__ 硬判断
    if (isNativeDropRecent()) return;
    if (enabled && !isProcessing) {
      const incoming = Array.from(e.dataTransfer.files);
      const files: File[] = [];
      const rejected: string[] = [];
      for (const file of incoming) {
        const limit = getAttachmentSizeLimitForFile(file.name, maxFileSize);
        if (file.size > limit) {
          rejected.push(
            `${file.name}: ${t('drag_drop:errors.file_too_large', {
              size: (limit / (1024 * 1024)).toFixed(1),
            })}`
          );
          continue;
        }
        files.push(file);
      }
      if (rejected.length) {
        const err = t('drag_drop:errors.all_files_failed', { reason: rejected.join('; ') });
        onValidationErrorRef.current?.(err as any, rejected);
        showGlobalNotification('warning', err);
      }
      if (files.length) {
        void onFilesDroppedRef.current(files);
      }
    }
  }, [enabled, isProcessing, updateDragState, maxFileSize, t]);

  const getSupportedFormatsDescription = useCallback(() => {
    if (acceptedFileTypes.some((t) => t.extensions.includes('*'))) return t('drag_drop:supported_formats.all');
    const keyOf = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '_');
    return acceptedFileTypes
      .map((ft) => t(`drag_drop:file_types.${keyOf(ft.description)}`))
      .join(', ');
  }, [acceptedFileTypes, t]);

  return (
    <div
      ref={dropZoneRef}
      className={`unified-drag-drop-zone relative ${className}`}
      style={style}
      data-zone-id={zoneId}
      data-dragging={isDragging}
      data-processing={isProcessing}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}
      {showOverlay && isDragging && (
        <div className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none" style={{ backgroundColor: 'hsl(var(--primary) / 0.1)', backdropFilter: 'blur(4px)' }}>
          <div className="flex flex-col items-center gap-4 px-8 py-6 rounded-lg shadow-lg pointer-events-none" style={{ backgroundColor: 'hsl(var(--background))', border: '2px dashed hsl(var(--primary))' }}>
            <div className="text-lg font-medium text-center" style={{ color: 'hsl(var(--foreground))' }}>
              {customOverlayText ||
                t('drag_drop:overlay.drop_files_here_with_format', {
                  formats: getSupportedFormatsDescription(),
                })}
            </div>
            {maxFiles > 1 && (
              <div className="text-sm text-center" style={{ color: 'hsl(var(--muted-foreground))' }}>
                {t('drag_drop:overlay.max_files', { max: maxFiles })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default UnifiedDragDropZone;
