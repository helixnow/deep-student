import { useState, useEffect, useCallback, useRef } from 'react';
import { guardedListen } from '../utils/guardedListen';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { showGlobalNotification } from '../components/UnifiedNotification';
import {
  ATTACHMENT_IMAGE_EXTENSIONS,
  ATTACHMENT_DOCUMENT_EXTENSIONS,
} from '@/chat-v2/core/constants';
import i18n from '@/i18n';

// 扩展名到 MIME 类型映射表（与 UnifiedDragDropZone EXTENSION_TO_MIME 保持一致）
const EXTENSION_TO_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
  heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  json: 'application/json', xml: 'application/xml',
  html: 'text/html', htm: 'text/html',
  epub: 'application/epub+zip', rtf: 'application/rtf',
};

// ============================================================================
// 🔧 Windows WebView2 兼容：全局 dragover/drop 事件 preventDefault
// WebView2 需要 document 级别的 dragover preventDefault 才会允许 drop 事件触发。
// macOS WebKit 的 Tauri 原生处理绕过了 web 层，但 Windows 必须 web 层也"接受"。
// ============================================================================
let _globalDragHandlersInstalled = false;
export function ensureGlobalDragHandlers() {
  if (_globalDragHandlersInstalled) return;
  _globalDragHandlersInstalled = true;
  document.addEventListener('dragover', (e) => {
    // 只对文件拖拽生效，不影响内部 drag-and-drop（如列表排序）
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  document.addEventListener('drop', (e) => {
    // 防止浏览器打开拖入的文件
    if (e.dataTransfer?.types?.includes('Files')) {
      e.preventDefault();
    }
  });
}

// 原生 drop 事件去重时间戳（用于避免 native + web 双重处理）
let _lastNativeDropTs = 0;
export function markNativeDrop() { _lastNativeDropTs = Date.now(); }
export function isNativeDropRecent() { return Date.now() - _lastNativeDropTs < 500; }

// 调试事件发射器（与 UnifiedDragDropZone 保持一致）
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
    console.warn('[useTauriDragAndDrop] Debug event emit failed:', e);
  }
};

interface UseTauriDragAndDropProps {
  dropZoneRef: React.RefObject<HTMLElement>;
  onDropFiles: (files: File[]) => void;
  isEnabled?: boolean;
  /**
   * If true, visibility checks will not fail when any ancestor has
   * pointer-events: none. This is useful for UIs where a fullscreen
   * container uses pointer-events: none while the inner drop target is
   * visually visible and should still accept drops (e.g. landing screens).
   */
  ignorePointerEventsNoneAncestors?: boolean;
  /**
   * 可选：调试标识符（用于调试面板区分不同实例）
   */
  debugZoneId?: string;
  /**
   * 可选：最大文件数量限制
   */
  maxFiles?: number;
  /**
   * 可选：单个文件大小限制（字节）
   */
  maxFileSize?: number;
  /**
   * 可选：仅提供拖拽状态反馈，不处理文件上传
   * 适用于文件处理由其他组件完成的场景（如笔记编辑器）
   */
  feedbackOnly?: boolean;
  /**
   * 可选：仅对特定扩展名的文件显示拖拽反馈
   * 例如：['png', 'jpg', 'jpeg', 'gif', 'webp'] 表示仅对图片文件显示反馈
   */
  feedbackExtensions?: string[];
}

export const useTauriDragAndDrop = ({
  dropZoneRef,
  onDropFiles,
  isEnabled = true,
  ignorePointerEventsNoneAncestors = false,
  debugZoneId,
  maxFiles,
  maxFileSize,
  feedbackOnly = false,
  feedbackExtensions,
}: UseTauriDragAndDropProps) => {
  const [isDragging, setIsDragging] = useState(false);
  
  // 检查文件路径是否匹配 feedbackExtensions
  const matchesFeedbackExtensions = useCallback((paths?: string[]): boolean => {
    if (!feedbackExtensions || feedbackExtensions.length === 0) return true;
    if (!paths?.length) return false;
    return paths.some(path => {
      const ext = path.split('.').pop()?.toLowerCase();
      return ext && feedbackExtensions.includes(ext);
    });
  }, [feedbackExtensions]);
  const onDropFilesRef = useRef(onDropFiles);
  const zoneId = debugZoneId || 'chat-input-legacy';

  useEffect(() => {
    onDropFilesRef.current = onDropFiles;
  }, [onDropFiles]);

  const isDropZoneVisible = useCallback(() => {
    if (!dropZoneRef.current) return false;
    const el = dropZoneRef.current;
    
    // 检查尺寸
    if (el.offsetWidth === 0 || el.offsetHeight === 0) return false;
    
    // 检查自身样式
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    
    // 🔥 关键修复：检查祖先容器的 opacity、pointer-events、z-index（页面切换机制）
    // ⚠️ 不在这里发送调试事件，避免性能问题
    let current: HTMLElement | null = el;
    while (current) {
      const computedStyle = window.getComputedStyle(current);
      
      // 检查 opacity（App.tsx 的页面切换使用 opacity: 0 隐藏）
      const opacity = parseFloat(computedStyle.opacity);
      if (opacity === 0) return false;
      
      // 检查 pointer-events（除非明确忽略）
      if (!ignorePointerEventsNoneAncestors && computedStyle.pointerEvents === 'none') return false;
      
      // 检查 z-index（App.tsx 的页面切换使用 z-index: -1）
      const zIndexValue = parseInt(computedStyle.zIndex, 10);
      if (!isNaN(zIndexValue) && zIndexValue < 0) return false;
      
      current = current.parentElement;
    }
    
    return true;
  }, [dropZoneRef, ignorePointerEventsNoneAncestors]);

  const processFilePaths = useCallback(
    async (paths: string[]) => {
      const startTime = performance.now();
      
      try {
        // ⚠️ 可见性检查已在监听器入口完成，这里可以直接处理
        emitDebugEvent(zoneId, 'drop_received', 'info', `接收到 ${paths.length} 个文件路径`, { 
          filePaths: paths,
          maxFiles: maxFiles || '无限制',
          maxFileSize: maxFileSize ? `${(maxFileSize / (1024 * 1024)).toFixed(1)}MB` : '无限制',
        });

        const acceptedFiles: File[] = [];
        const rejectedFiles: string[] = [];
        let oversizeCount = 0;
        let overLimitCount = 0;
        
        // 数量限制检查
        const pathsToProcess = maxFiles && paths.length > maxFiles 
          ? (overLimitCount = paths.length - maxFiles, paths.slice(0, maxFiles))
          : paths;
        
        if (overLimitCount > 0) {
          emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件数量超限: ${paths.length} > ${maxFiles}`, {
            totalFiles: paths.length,
            maxFiles,
            rejectedCount: overLimitCount,
          });
          showGlobalNotification('warning', i18n.t('drag_drop:errors.file_count_exceeded', { max: maxFiles, defaultValue: 'File count exceeds limit. Only processing the first {{max}} files.' }));
        }
        
        const supportedTypesText = `图片: ${ATTACHMENT_IMAGE_EXTENSIONS.join('/')}, 文档: ${ATTACHMENT_DOCUMENT_EXTENSIONS.join('/')}`;
        emitDebugEvent(zoneId, 'validation_start', 'debug', `开始验证 ${pathsToProcess.length} 个文件`, {
          supportedTypes: supportedTypesText,
        });
        
        // 🔧 使用 Tauri IPC 读取文件，避免 asset protocol 在 Windows 上对含中文/空格路径的 fetch 失败
        const { invoke } = await import('@tauri-apps/api/core');
        const imageRegex = new RegExp(`\\.(${ATTACHMENT_IMAGE_EXTENSIONS.join('|')})$`, 'i');
        const documentRegex = new RegExp(`\\.(${ATTACHMENT_DOCUMENT_EXTENSIONS.join('|')})$`, 'i');

        for (const path of pathsToProcess) {
          const fileName = path.split(/[/\\]/).pop() || 'file';
          const isImage = imageRegex.test(path);
          const isDocument = documentRegex.test(path);
          
          if (!(isImage || isDocument)) {
            rejectedFiles.push(`${fileName}: 不支持的文件类型`);
            emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件类型不支持: ${fileName}`, {
              fileName,
              path,
            });
            continue;
          }
          
          try {
            // 先检查文件大小（避免读入超大文件到内存）
            if (maxFileSize) {
              const fileSize = await invoke<number>('get_file_size', { path });
              if (fileSize > maxFileSize) {
                oversizeCount++;
                const sizeMB = (maxFileSize / (1024 * 1024)).toFixed(1);
                rejectedFiles.push(`${fileName}: 文件过大 (${(fileSize / (1024 * 1024)).toFixed(2)}MB > ${sizeMB}MB)`);
                emitDebugEvent(zoneId, 'validation_failed', 'warning', `文件过大: ${fileName}`, {
                  fileName,
                  fileSize: `${(fileSize / (1024 * 1024)).toFixed(2)}MB`,
                  maxSize: `${sizeMB}MB`,
                });
                continue;
              }
            }

            const rawBytes = await invoke<number[]>('read_file_bytes', { path });
            const bytes = new Uint8Array(rawBytes);
            
            // 推断 MIME 类型（使用完整映射表，与 UnifiedDragDropZone 保持一致）
            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            const mimeType = EXTENSION_TO_MIME[ext] || 'application/octet-stream';
            
            let finalFileName = fileName;
            if (!finalFileName.includes('.')) {
              const fallbackExt = isImage ? 'jpg' : 'bin';
              finalFileName = `${finalFileName}.${fallbackExt}`;
            }
            
            const file = new File([bytes], finalFileName, {
              type: mimeType,
              lastModified: Date.now(),
            });
            
            acceptedFiles.push(file);
            emitDebugEvent(zoneId, 'file_converted', 'debug', `文件转换成功: ${finalFileName}`, {
              fileName: finalFileName,
              fileSize: `${(bytes.length / (1024 * 1024)).toFixed(2)}MB`,
              mimeType: file.type,
            });
          } catch (error: unknown) {
            console.error('[useTauriDragAndDrop] 处理拖拽文件失败:', path, error);
            rejectedFiles.push(`${fileName}: ${String(error)}`);
            emitDebugEvent(zoneId, 'file_processing', 'error', `文件处理失败: ${fileName}`, {
              fileName,
              error: String(error),
            });
          }
        }

        if (rejectedFiles.length > 0) {
          emitDebugEvent(zoneId, 'validation_failed', 'warning', `${rejectedFiles.length} 个文件被拒绝`, {
            rejectedCount: rejectedFiles.length,
            rejectedFiles: rejectedFiles.slice(0, 5),
          });
        }

        if (acceptedFiles.length > 0) {
          // 去重：同一批次内部按 name+size 去重
          const keyOf = (f: File) => `${f.name}_${f.size}_${f.type}`;
          const uniqMap = new Map<string, File>();
          for (const f of acceptedFiles) {
            const k = keyOf(f);
            if (!uniqMap.has(k)) uniqMap.set(k, f);
          }
          
          const uniqueFiles = Array.from(uniqMap.values());
          const duplicateCount = acceptedFiles.length - uniqueFiles.length;
          
          if (duplicateCount > 0) {
            emitDebugEvent(zoneId, 'validation_start', 'debug', `去重：移除 ${duplicateCount} 个重复文件`, {
              totalFiles: acceptedFiles.length,
              uniqueFiles: uniqueFiles.length,
              duplicateCount,
            });
          }
          
          emitDebugEvent(zoneId, 'callback_invoked', 'debug', `调用 onDropFiles (${uniqueFiles.length} 个文件)`, {
            fileNames: uniqueFiles.map(f => f.name),
          });
          
          onDropFilesRef.current(uniqueFiles);
          
          emitDebugEvent(zoneId, 'complete', 'info', `文件处理完成: ${uniqueFiles.length} 个成功, ${rejectedFiles.length} 个失败`, {
            successCount: uniqueFiles.length,
            rejectedCount: rejectedFiles.length,
            oversizeCount,
            overLimitCount,
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          });
        } else if (rejectedFiles.length > 0) {
          // 所有文件都失败了，通知用户
          showGlobalNotification('error', i18n.t('drag_drop:errors.all_files_failed', {
            reason: rejectedFiles[0],
          }));
          emitDebugEvent(zoneId, 'complete', 'error', `所有文件处理失败: ${rejectedFiles.length} 个`, {
            rejectedFiles: rejectedFiles.slice(0, 5),
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          });
        } else {
          emitDebugEvent(zoneId, 'complete', 'warning', '没有可处理的文件', {
            processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
          });
        }
      } catch (fatalError: unknown) {
        console.error('[useTauriDragAndDrop] processFilePaths fatal error:', fatalError);
        showGlobalNotification('error', i18n.t('drag_drop:errors.all_files_failed', {
          reason: String(fatalError),
        }));
        emitDebugEvent(zoneId, 'callback_error', 'error', `processFilePaths 致命错误: ${String(fatalError)}`, {
          error: String(fatalError),
          processingTime: `${(performance.now() - startTime).toFixed(2)}ms`,
        });
      }
    },
    [zoneId, maxFiles, maxFileSize]
  );

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    // 🔧 Windows WebView2 兼容：确保全局 dragover/drop 处理器已安装
    ensureGlobalDragHandlers();

    let unlisten: (() => void) | undefined;
    let unlisteners: Array<() => void> = [];
    let disposed = false;
    const registerUnlisten = (fn: () => void) => {
      if (disposed) {
        fn();
        return;
      }
      unlisteners.push(fn);
    };

    const setupListeners = async () => {
      try {
        const webview = getCurrentWebview();
        const nextUnlisten = await webview.onDragDropEvent((event) => {
          // 🔥 提前静默检查可见性，不可见就直接返回，不发送任何日志
          if (!isEnabled || !isDropZoneVisible()) return;
          
          // 类型安全访问 paths（只有 enter 和 drop 事件有 paths）
          const paths = 'paths' in event.payload ? event.payload.paths : undefined;
          
          switch (event.payload.type) {
            case 'enter':
              // 如果设置了 feedbackExtensions，只对匹配的文件显示反馈
              if (feedbackExtensions && paths && !matchesFeedbackExtensions(paths)) {
                return;
              }
              setIsDragging(true);
              emitDebugEvent(zoneId, 'drag_enter', 'debug', '拖拽进入区域', {
                enabled: isEnabled,
              });
              break;
            case 'leave':
              setIsDragging(false);
              emitDebugEvent(zoneId, 'drag_leave', 'debug', '拖拽离开区域', {
                enabled: isEnabled,
              });
              break;
            case 'drop':
              setIsDragging(false);
              markNativeDrop(); // 标记原生 drop 已处理
              // feedbackOnly 模式下不处理文件
              if (feedbackOnly) {
                emitDebugEvent(zoneId, 'drop_received', 'debug', 'feedbackOnly 模式，跳过文件处理', {});
                return;
              }
              if (paths) {
                processFilePaths(paths);
              }
              break;
          }
        });
        if (disposed) {
          nextUnlisten();
          return;
        }
        unlisten = nextUnlisten;
        emitDebugEvent(zoneId, 'drag_enter', 'debug', '已注册 Tauri v2 拖拽监听器', {
          api: 'getCurrentWebview().onDragDropEvent',
        });
      } catch (e: unknown) {
        emitDebugEvent(zoneId, 'drag_enter', 'debug', 'Tauri v2 API 不可用，使用兼容模式', {
          error: String(e),
        });
        try {
          registerUnlisten(
            await guardedListen('tauri://drag-enter', () => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              setIsDragging(true);
              emitDebugEvent(zoneId, 'drag_enter', 'debug', '拖拽进入区域 (兼容模式)', {
                enabled: isEnabled,
              });
            })
          );
          registerUnlisten(
            await guardedListen('tauri://drag-leave', () => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              setIsDragging(false);
              emitDebugEvent(zoneId, 'drag_leave', 'debug', '拖拽离开区域 (兼容模式)', {
                enabled: isEnabled,
              });
            })
          );
          registerUnlisten(
            await guardedListen('tauri://drag-drop', (event: any) => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              const paths = event.payload?.paths;
              setIsDragging(false);
              markNativeDrop(); // 标记原生 drop 已处理
              // feedbackOnly 模式下不处理文件
              if (feedbackOnly) return;
              if (paths?.length) processFilePaths(paths);
            })
          );
          // 兼容 Tauri file-drop 系列事件
          registerUnlisten(
            await guardedListen('tauri://file-drop-hover', () => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              setIsDragging(true);
              emitDebugEvent(zoneId, 'drag_enter', 'debug', '拖拽进入区域 (file-drop-hover)', {
                enabled: isEnabled,
              });
            })
          );
          registerUnlisten(
            await guardedListen('tauri://file-drop-cancelled', () => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              setIsDragging(false);
              emitDebugEvent(zoneId, 'drag_leave', 'debug', '拖拽离开区域 (file-drop-cancelled)', {
                enabled: isEnabled,
              });
            })
          );
          registerUnlisten(
            await guardedListen('tauri://file-drop', (event: any) => {
              // 🔥 提前静默检查
              if (!isEnabled || !isDropZoneVisible()) return;
              const paths = Array.isArray(event?.payload) ? event.payload : event?.payload?.paths;
              setIsDragging(false);
              markNativeDrop(); // 标记原生 drop 已处理
              // feedbackOnly 模式下不处理文件
              if (feedbackOnly) return;
              if (paths?.length) {
                processFilePaths(paths);
              }
            })
          );
          emitDebugEvent(zoneId, 'drag_enter', 'debug', '已注册兼容模式拖拽监听器', {
            api: 'tauri://drag-* + tauri://file-drop*',
          });
        } catch (error: unknown) {
          console.log('[useTauriDragAndDrop] Tauri drag & drop listeners not available.');
          emitDebugEvent(zoneId, 'callback_error', 'error', 'Tauri 拖拽监听器注册失败', {
            error: String(error),
          });
        }
      }
    };

    setupListeners();

    return () => {
      disposed = true;
      unlisten?.();
      unlisteners.forEach((fn) => fn());
      unlisteners = [];
    };
  }, [isEnabled, processFilePaths, isDropZoneVisible, zoneId, feedbackOnly, feedbackExtensions, matchesFeedbackExtensions]);

  const dropZoneProps = {
    onDragEnter: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isEnabled) {
        setIsDragging(true);
        emitDebugEvent(zoneId, 'drag_enter', 'debug', '拖拽进入区域 (Web API)', {
          enabled: isEnabled,
        });
      }
    },
    onDragLeave: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        setIsDragging(false);
        emitDebugEvent(zoneId, 'drag_leave', 'debug', '拖拽离开区域 (Web API)', {
          enabled: isEnabled,
        });
      }
    },
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isEnabled) e.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);
      // 🔧 Windows 兼容：用时间戳去重替代 __TAURI_INTERNALS__ 硬判断
      // 如果原生 drop 事件刚刚（500ms 内）已处理过，跳过 web 层避免双重处理
      // 如果原生 drop 没触发（Windows WebView2 场景），web 层作为后备
      if (isNativeDropRecent()) {
        emitDebugEvent(zoneId, 'drop_received', 'debug', '原生 drop 已处理，跳过 Web 后备', {});
        return;
      }
      if (isEnabled && !feedbackOnly) {
        const allFiles = Array.from(e.dataTransfer.files);
        emitDebugEvent(zoneId, 'drop_received', 'info', `接收到 ${allFiles.length} 个文件 (Web fallback)`, {
          fileCount: allFiles.length,
          fileNames: allFiles.map(f => f.name),
        });
        
        const imageRegex = new RegExp(`\\.(${ATTACHMENT_IMAGE_EXTENSIONS.join('|')})$`, 'i');
        const documentRegex = new RegExp(`\\.(${ATTACHMENT_DOCUMENT_EXTENSIONS.join('|')})$`, 'i');
        const files = allFiles.filter(
          (f) => f.type.startsWith('image/') || imageRegex.test(f.name) || documentRegex.test(f.name)
        );
        
        const rejectedCount = allFiles.length - files.length;
        if (rejectedCount > 0) {
          emitDebugEvent(zoneId, 'validation_failed', 'warning', `${rejectedCount} 个文件类型不支持 (Web fallback)`, {
            rejectedCount,
          });
        }
        
        if (files.length > 0) {
          emitDebugEvent(zoneId, 'callback_invoked', 'debug', `调用 onDropFiles (${files.length} 个文件, Web fallback)`, {
            fileNames: files.map(f => f.name),
          });
          onDropFilesRef.current(files as any);
          emitDebugEvent(zoneId, 'complete', 'info', `文件处理完成 (Web fallback): ${files.length} 个`, {
            successCount: files.length,
          });
        } else if (allFiles.length > 0) {
          showGlobalNotification('warning', i18n.t('drag_drop:errors.unsupported_type'));
        }
      }
    },
  };

  return { isDragging, dropZoneProps };
}; 
