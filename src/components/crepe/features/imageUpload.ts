/**
 * Crepe 编辑器图片上传功能
 * 集成 Tauri 文件系统和笔记资产管理
 */

import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appDataDir } from '@tauri-apps/api/path';
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import { getErrorMessage } from '../../../utils/errorUtils';
import { extractFileName, extractFileExtension } from '../../../utils/fileManager';
import { emitImageUploadDebug } from '../../../debug-panel/plugins/CrepeImageUploadDebugPlugin';
import { showGlobalNotification } from '../../UnifiedNotification';

/**
 * 通过后端命令获取图片的 base64 数据
 * 绕过 asset:// 协议可能的 scope 限制问题
 */
async function getImageAsBase64(path: string): Promise<string> {
  return invoke<string>('get_image_as_base64', { relativePath: path });
}
// ImageBlockFeatureConfig 类型定义
interface ImageBlockFeatureConfig {
  onUpload?: (file: File) => Promise<string>;
  proxyDomURL?: (url: string) => Promise<string> | string;
  inlineImageIcon?: string;
  inlineConfirmButton?: string;
  inlineUploadButton?: string;
  inlineUploadPlaceholderText?: string;
  inlineOnUpload?: (file: File) => Promise<string>;
  blockImageIcon?: string;
  blockConfirmButton?: string;
  blockCaptionIcon?: string;
  blockUploadButton?: string;
  blockCaptionPlaceholderText?: string;
  blockUploadPlaceholderText?: string;
  blockOnUpload?: (file: File) => Promise<string>;
}
import i18next from 'i18next';

/**
 * 降级路径 blob URL 的实例级注册表。
 * blob URL 仅当前会话有效且不会被 GC 自动回收；编辑器实例销毁时统一 revoke，
 * 避免长会话内反复降级上传导致的内存泄漏。
 */
export interface TransientBlobUrlRegistry {
  register: (url: string) => void;
  releaseAll: () => void;
}

export const createTransientBlobUrlRegistry = (): TransientBlobUrlRegistry => {
  const urls = new Set<string>();
  return {
    register: (url: string) => {
      urls.add(url);
    },
    releaseAll: () => {
      urls.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch { /* URL 可能已随文档卸载失效 */ }
      });
      urls.clear();
    },
  };
};

/**
 * 将 File 转换为 base64 字符串
 */
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const result = String(reader.result || '');
        const idx = result.indexOf('base64,');
        resolve(idx >= 0 ? result.slice(idx + 7) : result);
      } catch (e) {
        reject(e);
      }
    };
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(file);
  });
};

/**
 * 创建图片上传处理函数
 * @param blobRegistry 可选；降级路径创建的 blob URL 会登记于此，由宿主在销毁时统一 revoke
 */
export const createImageUploader = (
  noteId: string | undefined,
  blobRegistry?: TransientBlobUrlRegistry
): ((file: File) => Promise<string>) => {
  return async (file: File): Promise<string> => {
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
    if (file.size > MAX_IMAGE_SIZE) {
      showGlobalNotification('warning', i18next.t('notes:editor.image_upload.too_large'));
      return '';
    }

    const nid = (noteId || '').trim();

    emitImageUploadDebug('upload_start', 'info', '开始处理图片上传', {
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      noteId: nid,
      hasContext: !!nid,
    });

    // 如果有笔记上下文，保存到笔记资产目录
    if (nid) {
      try {
        emitImageUploadDebug('file_convert', 'debug', '开始转换文件为 base64', {
          fileName: file.name,
        });
        
        const base64 = await fileToBase64(file);
        const ext = file.name.split('.').pop() || 'png';
        
        emitImageUploadDebug('file_convert', 'success', 'Base64 转换成功', {
          base64Length: base64.length,
          ext,
        });
        
        emitImageUploadDebug('upload_start', 'info', '调用 notes_save_asset', {
          noteId: nid,
          ext,
          base64Length: base64.length,
        });

        // P1-15: 后端要求 subject 参数，使用默认值 "_global"
        const saved = await invoke<{ absolute_path: string; relative_path: string }>('notes_save_asset', {
          subject: '_global',
          note_id: nid,
          noteId: nid,
          base64_data: base64,
          base64Data: base64,
          default_ext: ext,
          defaultExt: ext,
        });

        emitImageUploadDebug('upload_complete', 'success', 'notes_save_asset 返回成功', {
          absolutePath: saved.absolute_path,
          relativePath: saved.relative_path,
        });

        // 🔧 P0-18 修复：返回稳定的相对路径引用，而不是 base64 data URL
        // 原问题：base64 data URL 写入 markdown 正文会轻易超过 1MB 限制
        // 解决方案：使用 notes_assets/... 相对路径，proxyDomURL 会在渲染时转换为可显示的 URL
        // 这样：
        // 1. markdown 正文只存储小体积的路径引用（如 "notes_assets/abc123.png"）
        // 2. 图片文件已经通过 notes_save_asset 保存到磁盘
        // 3. 编辑器渲染时 proxyDomURL 会自动转换路径为 data URL 显示
        const stableRef = saved.relative_path;

        emitImageUploadDebug('upload_complete', 'info', '使用稳定路径引用代替 data URL', {
          stableRef,
          reason: 'avoid_1MB_content_limit',
        });

        return stableRef;
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('[CrepeEditor] Failed to save image asset:', error);
        
        emitImageUploadDebug('error', 'error', '图片保存失败', {
          error: message,
          errorType: (error as any)?.constructor?.name,
          errorStack: (error as Error)?.stack?.slice(0, 500),
          noteId: nid,
        });
        
        // ★ Y8 修复：原 'dstu:toast' 自定义事件没有任何监听者（死通道），
        // 保存失败对用户完全静默。改用全局通知直接提示。
        showGlobalNotification(
          'error',
          i18next.t('notes:editor.image_upload.save_failed', { error: message })
        );
        // A blob URL would look valid for this session but becomes a broken
        // image after restart. Keep persistent notes free of transient URLs.
        return '';
      }
    } else {
      emitImageUploadDebug('upload_start', 'warning', '缺少笔记上下文，将使用 blob URL', {
        noteId: nid,
        reason: 'missing_noteId',
      });
    }

    // 降级：返回 blob URL
    // ★ Y8 修复：blob URL 仅当前会话有效，重启后图片将丢失。明确告知用户。
    showGlobalNotification(
      'warning',
      i18next.t('notes:editor.image_upload.not_persisted')
    );
    const blobUrl = URL.createObjectURL(file);
    blobRegistry?.register(blobUrl);
    emitImageUploadDebug('upload_complete', 'info', '使用 blob URL（降级方案）', {
      blobUrl,
      fileName: file.name,
    });
    return blobUrl;
  };
};

/**
 * 触屏/窄屏编辑面判定（与 NotesCrepeEditor 的 isTouchEditingSurface 口径一致：
 * isSmallScreen(<768, 对齐 BREAKPOINTS.md) || (pointer: coarse)）。
 * 移动端没有「拖拽上传」场景，上传区文案需去掉拖拽话术。
 */
export const isTouchEditingSurface = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 768;
  } catch {
    return false;
  }
};

/**
 * 创建图片块功能配置
 */
export const createImageBlockConfig = (
  noteId: string | undefined,
  blobRegistry?: TransientBlobUrlRegistry
): ImageBlockFeatureConfig => {
  const uploader = createImageUploader(noteId, blobRegistry);
  // 触屏/窄屏没有拖拽场景：上传区提示改为「点击上传图片」
  const uploadPlaceholderKey = isTouchEditingSurface()
    ? 'notes:editor.image_upload.placeholder_touch'
    : 'notes:editor.image_upload.placeholder';

  return {
    // 块级图片上传（上传按钮默认是英文 "Upload file"，这里统一 i18n）
    blockOnUpload: uploader,
    blockUploadButton: i18next.t('notes:editor.image_upload.upload_button'),
    blockUploadPlaceholderText: i18next.t(uploadPlaceholderKey),
    blockCaptionPlaceholderText: i18next.t('notes:editor.image_upload.caption_placeholder'),
    
    // 内联图片上传
    inlineOnUpload: uploader,
    inlineUploadButton: i18next.t('notes:editor.image_upload.upload_button_inline'),
    inlineUploadPlaceholderText: i18next.t('notes:editor.image_upload.inline_placeholder'),
    
    // 代理图片 URL：将路径转换为可显示的 URL
    // macOS WebView 不支持直接在 img 标签中加载 asset:// URL，需要转换为 blob URL
    proxyDomURL: async (url: string) => {
      emitImageUploadDebug('file_read', 'debug', 'proxyDomURL 被调用', {
        inputUrl: url?.slice(0, 100),
        urlLength: url?.length || 0,
      });
      
      // 如果是 http/https/blob/data URL，直接返回
      if (url.startsWith('http://') || url.startsWith('https://') || 
          url.startsWith('blob:') || url.startsWith('data:')) {
        emitImageUploadDebug('file_read', 'debug', 'proxyDomURL: 网络/blob/data URL，直接返回', {
          urlType: url.split(':')[0],
        });
        return url;
      }
      
      // 🔧 关键修复：对于 asset:// URL，通过后端命令获取 data URL
      // macOS WebView 的 asset 协议可能有 scope 限制，使用后端绕过
      if (url.startsWith('asset://') || url.startsWith('tauri://')) {
        try {
          emitImageUploadDebug('file_read', 'info', 'proxyDomURL: 通过后端获取图片 data URL', {
            assetUrl: url?.slice(0, 100),
          });
          
          const base64Data = await getImageAsBase64(url);
          const dataUrl = base64Data.startsWith('data:') ? base64Data : `data:image/jpeg;base64,${base64Data}`;
          
          emitImageUploadDebug('file_read', 'success', 'proxyDomURL: data URL 获取成功', {
            originalUrl: url?.slice(0, 80),
            dataUrlLength: dataUrl.length,
          });
          
          return dataUrl;
        } catch (e) {
          emitImageUploadDebug('error', 'error', 'proxyDomURL: 后端获取图片失败', {
            url: url?.slice(0, 100),
            error: getErrorMessage(e),
          });
          // 返回原 URL 作为降级
          return url;
        }
      }
      
      // 如果是 notes_assets 相对路径，通过后端获取 data URL
      if (url.startsWith('notes_assets/') && isTauriEnv()) {
        try {
          emitImageUploadDebug('file_read', 'info', 'proxyDomURL: 相对路径 -> 后端获取', {
            relativePath: url,
          });
          
          // 直接传递相对路径给后端，后端会自动处理
          const base64Data = await getImageAsBase64(url);
          const dataUrl = base64Data.startsWith('data:') ? base64Data : `data:image/jpeg;base64,${base64Data}`;
          
          emitImageUploadDebug('file_read', 'success', 'proxyDomURL: 相对路径转换成功', {
            inputUrl: url,
            dataUrlLength: dataUrl.length,
          });
          
          return dataUrl;
        } catch (e) {
          emitImageUploadDebug('error', 'error', 'proxyDomURL: 转换相对路径失败', {
            url,
            error: getErrorMessage(e),
          });
          console.error('[imageUpload] proxyDomURL: failed to convert relative path', e);
        }
      } else if (url && !url.startsWith('data:')) {
        emitImageUploadDebug('file_read', 'warning', 'proxyDomURL: 未识别的 URL 格式，原样返回', {
          url: url?.slice(0, 100),
          isTauri: isTauriEnv(),
        });
      }
      return url;
    },
  };
};

/**
 * 检查是否在 Tauri 环境中运行
 */
const isTauriEnv = (): boolean => {
  if (typeof window === 'undefined') return false;
  return Boolean((window as any).__TAURI_INTERNALS__);
};

/**
 * 使用 Tauri dialog 选择图片文件
 * 在 Tauri 环境下替代浏览器原生 file input
 * 使用 convertFileSrc + fetch 方式读取文件（与 UnifiedDragDropZone 保持一致）
 */
export const pickImageWithTauriDialog = async (): Promise<File | null> => {
  // 检查是否在 Tauri 环境
  if (!isTauriEnv()) {
    console.warn('[imageUpload] Not in Tauri environment, cannot use native dialog');
    return null;
  }
  
  try {
    console.log('[imageUpload] Opening Tauri file dialog...');
    
    const selected = await dialogOpen({
      multiple: false,
      directory: false,
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'heic', 'heif'],
        },
      ],
    });

    console.log('[imageUpload] Dialog result:', selected);

    if (!selected || typeof selected !== 'string') {
      console.log('[imageUpload] No file selected');
      return null;
    }

    // 使用 convertFileSrc 将本地路径转换为 asset:// URL
    const assetUrl = convertFileSrc(selected);
    console.log('[imageUpload] Asset URL:', assetUrl);
    
    // 通过 fetch 读取文件内容
    const response = await fetch(assetUrl);
    if (!response.ok) {
      console.error('[imageUpload] Fetch failed:', response.status, response.statusText);
      return null;
    }
    
    const blob = await response.blob();
    const fileName = extractFileName(selected) || 'image.png';
    
    let mimeType = blob.type;
    if (!mimeType || mimeType === 'application/octet-stream') {
      const ext = extractFileExtension(selected) || 'png';
      const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        svg: 'image/svg+xml',
        heic: 'image/heic',
        heif: 'image/heif',
      };
      mimeType = mimeMap[ext] || 'image/png';
    }

    // 创建 File 对象
    const file = new File([blob], fileName, { type: mimeType });
    console.log('[imageUpload] File created:', file.name, file.size, file.type);
    return file;
  } catch (error) {
    console.error('[imageUpload] pickImageWithTauriDialog failed:', error);
    return null;
  }
};

/**
 * 在编辑器中注入 Tauri 图片选择器
 * 拦截 ImageBlock 的点击事件，使用 Tauri dialog 替代浏览器原生 file input
 */
export const injectTauriImagePicker = (
  container: HTMLElement,
  uploader: (file: File) => Promise<string>
): (() => void) => {
  const handleClick = async (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    
    // 检查是否点击了图片上传区域
    // Crepe ImageBlock 的上传区域通常有 .image-placeholder 或 data-placeholder 属性
    const uploadArea = target.closest(
      '.milkdown-image-block [data-placeholder], ' +
      '.milkdown-image-block .image-placeholder, ' +
      '.milkdown-image-block .upload-area, ' +
      '.milkdown [class*="image"] [class*="upload"], ' +
      '.milkdown [class*="image"] [class*="placeholder"]'
    );
    
    if (!uploadArea) return;

    // 阻止默认行为（浏览器原生 file input）
    e.preventDefault();
    e.stopPropagation();

    // 使用 Tauri dialog 选择图片
    const file = await pickImageWithTauriDialog();
    if (!file) return;

    try {
      // 调用上传函数获取 URL
      const url = await uploader(file);
      
      // 触发自定义事件，通知编辑器插入图片
      // Crepe/Milkdown 会监听这个事件来更新图片
      const event = new CustomEvent('crepe:image-uploaded', {
        detail: { url, file },
        bubbles: true,
      });
      uploadArea.dispatchEvent(event);
      
      console.log('[imageUpload] Image uploaded via Tauri dialog:', url);
    } catch (error) {
      console.error('[imageUpload] Upload failed:', error);
    }
  };

  // 使用 capture 阶段拦截事件
  container.addEventListener('click', handleClick, { capture: true });

  return () => {
    container.removeEventListener('click', handleClick, { capture: true });
  };
};
