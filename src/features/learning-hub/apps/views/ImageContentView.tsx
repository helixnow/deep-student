/**
 * 图片内容视图
 * 
 * 用于在 Learning Hub 中预览图片附件。
 * 支持缩放、旋转、拖拽平移、键盘操作等功能。
 * 
 * ★ 2026-02 优化：渐进式加载支持
 * - 小文件（< 10MB）：直接加载 base64
 * - 大文件（>= 10MB）：显示警告，用户确认后加载
 * - 添加加载进度指示
 * 
 * ★ 2026-07 优化：交互与生命周期
 * - Ctrl/Cmd + 滚轮缩放改用原生非 passive 监听（React onWheel 无法 preventDefault，
 *   会同时触发 WebView 页面缩放）
 * - 缩放锚点：滚轮/双击缩放锚定指针位置，按钮/键盘缩放锚定视口中心
 *   （基于缩放前后 getBoundingClientRect 实测，天然兼容旋转与 padding）
 * - 拖拽平移（pointer capture，仅鼠标；触摸沿用原生滚动），grab/grabbing 光标
 * - 双击在 100% 与 200% 之间切换
 * - 旋转 90°/270° 时按自然尺寸+视口宽度计算包围盒，修复布局盒与视觉盒不一致
 *   导致的裁切/滚动区域错误；每次旋转后滚动居中
 * - 键盘支持：+/- 缩放、0 重置、R 旋转、方向键平移、Esc 重置
 * - 加载竞态防护（切换节点时丢弃过期结果，避免 ObjectURL 泄漏）
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowClockwise, ArrowsOut, Warning, Download, CircleNotch, ImageBroken } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';

import { base64ToBlob, base64ToUint8Array } from '@/utils/base64FileUtils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { formatFileSize } from './previewUtils';

/** 图片大文件确认阈值（后端图片上限 50MB；超过 20MB 先提示再加载） */
const IMAGE_LARGE_FILE_THRESHOLD = 20 * 1024 * 1024;

const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
const ZOOM_STEP = 25;
/** 双击放大的目标倍率 */
const ZOOM_DOUBLE_CLICK = 200;
/** 方向键平移步长（px） */
const PAN_STEP = 48;
/** 图片区 wrapper 的 p-4 内边距（px，Tailwind 默认 1rem=16px） */
const CONTENT_PADDING_PX = 16;

const clampZoom = (value: number): number => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));

interface Size {
  w: number;
  h: number;
}

/** 缩放锚点：图片包围盒内的比例坐标 (fx, fy) + 应保持不动的屏幕坐标 (cx, cy) */
interface ZoomAnchor {
  fx: number;
  fy: number;
  cx: number;
  cy: number;
}

/** 附件元数据类型 */
interface VfsAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentHash?: string;
}

/** 加载阶段 */
type LoadingStage = 'idle' | 'checking' | 'loading' | 'done' | 'large_file_warning';

/**
 * 图片内容视图组件
 */
const ImageContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  
  // 状态
  // ★ zoom 允许小数：滚轮/捏合的小步进若强制取整，在低倍率下会被 round 吞掉
  //   （如 100 × 0.998 ≈ 99.8 → round 回 100，手势卡死）。仅显示时取整。
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // ★ 初始即为 checking，避免首帧短暂闪现"图片未找到"错误分支
  const [loadingStage, setLoadingStage] = useState<LoadingStage>('checking');
  const [error, setError] = useState<string | null>(null);
  // ★ 2026-06-12（审阅问题 M2）：渲染失败状态（解码失败/系统不支持的格式如 HEIC）
  const [renderFailed, setRenderFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fileSize, setFileSize] = useState<number>(0);
  const [loadStartTime, setLoadStartTime] = useState<number>(0);
  // 图片自然尺寸（旋转包围盒计算依赖）与视口尺寸（随窗口变化）
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [viewportSize, setViewportSize] = useState<Size | null>(null);
  // 拖拽平移状态
  const [isPanning, setIsPanning] = useState(false);
  const [isPannable, setIsPannable] = useState(false);
  
  // 用于清理 ObjectURL
  const objectUrlRef = useRef<string | null>(null);
  // ★ 加载代次：切换节点/卸载后使旧的异步结果失效，防止状态错乱与 URL 泄漏
  const loadGenRef = useRef(0);
  // 滚动视口元素（用于原生滚轮监听、平移与缩放锚点换算）
  const viewportElRef = useRef<HTMLDivElement | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const zoomAnchorRef = useRef<ZoomAnchor | null>(null);
  const panPointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  
  // ★ 驱动加载耗时实时更新
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loadingStage !== 'loading') return;
    const id = setInterval(() => setTick((prev) => prev + 1), 1000);
    return () => clearInterval(id);
  }, [loadingStage]);

  // 从 node 的 metadata 获取图片信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'image/png';
  const isLikelyUnsupportedFormat = /heic|heif/i.test(mimeType) || /\.(heic|heif)$/i.test(node.name);

  // 清理 ObjectURL + 使未完成的加载失效
  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, []);

  // 加载图片内容的核心函数
  // ★ 2026-06-12（审阅问题 M2/M10）：base64 → Blob → ObjectURL。
  // 旧实现直接拼 data: URL，base64 字符串与解码位图双份驻留内存，
  // 且 objectUrlRef 清理逻辑形同虚设（从未赋值）。
  const loadImageContent = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoadingStage('loading');
    setLoadStartTime(Date.now());
    setError(null);
    setRenderFailed(false);
    
    try {
      // 调用后端获取附件内容
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      
      // ★ 结果已过期（节点已切换或组件已卸载）：直接丢弃，不创建 ObjectURL
      if (gen !== loadGenRef.current) return;
      
      if (result.found && result.content) {
        const blob = base64ToBlob(result.content, mimeType);
        if (!blob) {
          setError(t('learningHub:error.imageDecodeFailed', '图片解码失败'));
          setLoadingStage('idle');
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = objectUrl;
        setImageUrl(objectUrl);
        setLoadingStage('done');
      } else {
        setError(t('learningHub:error.imageNotFound', '图片未找到'));
        setLoadingStage('idle');
      }
    } catch (err: unknown) {
      if (gen !== loadGenRef.current) return;
      setError(getErrorMessage(err));
      setLoadingStage('idle');
    }
  }, [node.id, mimeType, t]);

  // ★ 保存到本地（渲染失败/大文件场景的逃生通道）
  const handleSaveToDevice = useCallback(async () => {
    setIsSaving(true);
    try {
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      if (!result?.found || !result?.content) {
        showGlobalNotification('error', t('learningHub:error.imageNotFound', '图片未找到'));
        return;
      }
      const bytes = base64ToUint8Array(result.content);
      if (!bytes) {
        showGlobalNotification('error', t('learningHub:error.imageDecodeFailed', '图片解码失败'));
        return;
      }
      const ext = node.name.includes('.') ? node.name.split('.').pop() || '' : '';
      const saveResult = await fileManager.saveBinaryFile({
        data: bytes,
        defaultFileName: node.name,
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });
      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully', '文件已保存'));
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(saveResult.path);
        } catch {
          // 打开失败不阻塞，文件已保存
        }
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }, [node.id, node.name, t]);

  // 初始化：先检查文件大小
  useEffect(() => {
    const checkAndLoad = async () => {
      const gen = ++loadGenRef.current;
      // ★ 切换到新节点时重置视图状态，避免沿用上一张图的缩放/旋转/错误
      setLoadingStage('checking');
      setError(null);
      setRenderFailed(false);
      setImageUrl(null);
      setNaturalSize(null);
      setZoom(100);
      setRotation(0);
      
      try {
        // 先获取附件元数据
        const attachment = await invoke<VfsAttachment | null>('vfs_get_attachment', {
          attachmentId: node.id,
        });
        
        if (gen !== loadGenRef.current) return;
        
        if (!attachment) {
          setError(t('learningHub:error.imageNotFound', '图片未找到'));
          setLoadingStage('idle');
          return;
        }
        
        setFileSize(attachment.size);
        
        // 检查文件大小
        // ★ 2026-06-12（审阅问题 M8）：阈值改为图片专用 20MB。
        // 旧代码用通用 LARGE_FILE_THRESHOLD(100MB)，而图片上传上限远低于此，
        // 警告分支永远不可达。
        if (attachment.size >= IMAGE_LARGE_FILE_THRESHOLD) {
          // 大文件：显示警告，让用户决定是否加载
          setLoadingStage('large_file_warning');
        } else {
          // 小文件：直接加载
          await loadImageContent();
        }
      } catch (err: unknown) {
        if (gen !== loadGenRef.current) return;
        setError(getErrorMessage(err));
        setLoadingStage('idle');
      }
    };

    void checkAndLoad();
  }, [node.id, t, loadImageContent]);

  // ★ 缩放锚点捕获：记录"图片包围盒内的比例坐标"与"应保持不动的屏幕坐标"。
  // 不传坐标时锚定视口中心（按钮/键盘缩放）。基于实测 rect 而非比例推算，
  // 因此对 padding、m-auto 居中、旋转包围盒都天然正确。
  const captureZoomAnchor = useCallback((clientX?: number, clientY?: number) => {
    const img = imgRef.current;
    const vp = viewportElRef.current;
    if (!img || !vp) return;
    const rect = img.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const vpRect = vp.getBoundingClientRect();
    const cx = clientX ?? vpRect.left + vp.clientWidth / 2;
    const cy = clientY ?? vpRect.top + vp.clientHeight / 2;
    zoomAnchorRef.current = {
      fx: Math.min(1, Math.max(0, (cx - rect.left) / rect.width)),
      fy: Math.min(1, Math.max(0, (cy - rect.top) / rect.height)),
      cx,
      cy,
    };
  }, []);

  // 缩放控制（按钮/键盘：吸附到 25% 整数档位，滚轮的中间值不会导致步进漂移）
  const handleZoomIn = useCallback(() => {
    captureZoomAnchor();
    setZoom((prev) => clampZoom((Math.floor(Math.round(prev) / ZOOM_STEP) + 1) * ZOOM_STEP));
  }, [captureZoomAnchor]);

  const handleZoomOut = useCallback(() => {
    captureZoomAnchor();
    setZoom((prev) => clampZoom((Math.ceil(Math.round(prev) / ZOOM_STEP) - 1) * ZOOM_STEP));
  }, [captureZoomAnchor]);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setZoom(100);
    setRotation(0);
  }, []);

  // ★ 双击：在 100% 与 200% 之间切换，锚定双击位置
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    captureZoomAnchor(e.clientX, e.clientY);
    setZoom((prev) => (prev === 100 ? ZOOM_DOUBLE_CLICK : 100));
  }, [captureZoomAnchor]);

  // ★ 缩放后按锚点回填滚动位置（useLayoutEffect：布局已更新、尚未绘制，无闪跳）。
  // 无锚点（如切换节点重置 zoom）时跳过，浏览器自行钳制滚动。
  const prevZoomRef = useRef(100);
  useLayoutEffect(() => {
    if (prevZoomRef.current === zoom) return;
    prevZoomRef.current = zoom;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const vp = viewportElRef.current;
    const img = imgRef.current;
    if (!anchor || !vp || !img) return;
    const rect = img.getBoundingClientRect();
    vp.scrollLeft += rect.left + anchor.fx * rect.width - anchor.cx;
    vp.scrollTop += rect.top + anchor.fy * rect.height - anchor.cy;
  }, [zoom]);

  // ★ 旋转后内容朝向完全改变，滚动位置失去意义：居中显示
  const prevRotationRef = useRef(0);
  useLayoutEffect(() => {
    if (prevRotationRef.current === rotation) return;
    prevRotationRef.current = rotation;
    const vp = viewportElRef.current;
    if (!vp) return;
    vp.scrollLeft = (vp.scrollWidth - vp.clientWidth) / 2;
    vp.scrollTop = (vp.scrollHeight - vp.clientHeight) / 2;
  }, [rotation]);

  // ★ 是否可拖拽平移（内容溢出视口）；驱动 grab 光标。
  // 依赖项均为"会改变溢出状态"的触发源：缩放/旋转/视口尺寸/图片加载。
  useLayoutEffect(() => {
    const vp = viewportElRef.current;
    setIsPannable(
      !!vp && (vp.scrollWidth > vp.clientWidth + 1 || vp.scrollHeight > vp.clientHeight + 1)
    );
  }, [zoom, rotation, viewportSize, naturalSize, imageUrl]);

  // ★ Ctrl/Cmd + 滚轮缩放（含触控板捏合，浏览器上报为 ctrl+wheel），锚定指针位置。
  // 必须用原生非 passive 监听：React 的 onWheel 是 passive 的，
  // preventDefault 无效，会同时触发 WebView 页面级缩放。
  const handleNativeWheel = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    captureZoomAnchor(e.clientX, e.clientY);
    // 按 deltaY 指数缩放：鼠标滚轮一格约 ±18%，触控板捏合的小 delta 平滑连续
    const factor = Math.exp(-e.deltaY * 0.002);
    setZoom((prev) => clampZoom(prev * factor));
  }, [captureZoomAnchor]);

  // ★ 移动端双指捏合缩放：触屏没有 ctrl+wheel，捏合是唯一符合直觉的缩放手势。
  // 同样必须用原生非 passive touchmove（React 触摸监听为 passive，无法
  // preventDefault 阻止双指触发原生滚动）；锚定两指中点，松开一指即结束。
  const pinchStateRef = useRef<{ dist: number } | null>(null);
  const handleNativeTouchStart = useCallback((e: TouchEvent) => {
    if (e.touches.length === 2) {
      const [a, b] = [e.touches[0], e.touches[1]];
      pinchStateRef.current = { dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) };
    } else {
      pinchStateRef.current = null;
    }
  }, []);
  const handleNativeTouchMove = useCallback((e: TouchEvent) => {
    const pinch = pinchStateRef.current;
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = [e.touches[0], e.touches[1]];
    const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY);
    if (dist <= 0 || pinch.dist <= 0) return;
    const factor = dist / pinch.dist;
    pinch.dist = dist;
    captureZoomAnchor((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2);
    setZoom((prev) => clampZoom(prev * factor));
  }, [captureZoomAnchor]);
  const handleNativeTouchEnd = useCallback((e: TouchEvent) => {
    if (e.touches.length < 2) {
      pinchStateRef.current = null;
    }
  }, []);

  const setViewportEl = useCallback((el: HTMLDivElement | null) => {
    const prev = viewportElRef.current;
    if (prev) {
      prev.removeEventListener('wheel', handleNativeWheel);
      prev.removeEventListener('touchstart', handleNativeTouchStart);
      prev.removeEventListener('touchmove', handleNativeTouchMove);
      prev.removeEventListener('touchend', handleNativeTouchEnd);
      prev.removeEventListener('touchcancel', handleNativeTouchEnd);
    }
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    viewportElRef.current = el;
    if (el) {
      el.addEventListener('wheel', handleNativeWheel, { passive: false });
      el.addEventListener('touchstart', handleNativeTouchStart, { passive: true });
      el.addEventListener('touchmove', handleNativeTouchMove, { passive: false });
      el.addEventListener('touchend', handleNativeTouchEnd, { passive: true });
      el.addEventListener('touchcancel', handleNativeTouchEnd, { passive: true });
      const ro = new ResizeObserver(() => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        setViewportSize((prevSize) =>
          prevSize && prevSize.w === w && prevSize.h === h ? prevSize : { w, h }
        );
      });
      ro.observe(el);
      resizeObserverRef.current = ro;
    }
  }, [handleNativeWheel, handleNativeTouchStart, handleNativeTouchMove, handleNativeTouchEnd]);

  // ★ 拖拽平移（pointer capture）。仅鼠标主键：触摸/笔沿用滚动容器原生手势。
  const handlePanPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    const vp = viewportElRef.current;
    if (!vp) return;
    // 无溢出时不进入拖拽，保留默认行为
    if (vp.scrollWidth <= vp.clientWidth + 1 && vp.scrollHeight <= vp.clientHeight + 1) return;
    panPointerRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsPanning(true);
  }, []);

  const handlePanPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panPointerRef.current;
    if (!pan || e.pointerId !== pan.id) return;
    const vp = viewportElRef.current;
    if (!vp) return;
    vp.scrollLeft -= e.clientX - pan.x;
    vp.scrollTop -= e.clientY - pan.y;
    pan.x = e.clientX;
    pan.y = e.clientY;
  }, []);

  const handlePanPointerEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const pan = panPointerRef.current;
    if (!pan || e.pointerId !== pan.id) return;
    panPointerRef.current = null;
    setIsPanning(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  // ★ 键盘操作：+/- 缩放、0 重置、R 旋转、方向键平移、Esc 重置
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case '+':
      case '=':
        e.preventDefault();
        handleZoomIn();
        break;
      case '-':
      case '_':
        e.preventDefault();
        handleZoomOut();
        break;
      case '0':
        e.preventDefault();
        handleReset();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        handleRotate();
        break;
      case 'Escape':
        // 有变换时先重置；未变换时不拦截，让上层处理（如关闭面板）
        if (zoom !== 100 || rotation !== 0) {
          e.preventDefault();
          e.stopPropagation();
          handleReset();
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        viewportElRef.current?.scrollBy({ top: -PAN_STEP });
        break;
      case 'ArrowDown':
        e.preventDefault();
        viewportElRef.current?.scrollBy({ top: PAN_STEP });
        break;
      case 'ArrowLeft':
        e.preventDefault();
        viewportElRef.current?.scrollBy({ left: -PAN_STEP });
        break;
      case 'ArrowRight':
        e.preventDefault();
        viewportElRef.current?.scrollBy({ left: PAN_STEP });
        break;
      default:
        break;
    }
  }, [zoom, rotation, handleZoomIn, handleZoomOut, handleReset, handleRotate]);

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth, naturalHeight } = e.currentTarget;
    setNaturalSize((prev) =>
      prev && prev.w === naturalWidth && prev.h === naturalHeight
        ? prev
        : { w: naturalWidth, h: naturalHeight }
    );
  }, []);

  // 检查文件大小中
  if (loadingStage === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <p className="text-sm text-muted-foreground">
          {t('learningHub:image.checkingSize', '检查文件大小...')}
        </p>
      </div>
    );
  }

  // 大文件警告
  if (loadingStage === 'large_file_warning') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <div className="flex items-center gap-2 text-amber-500">
          <Warning size={32} />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-lg font-medium">
            {t('learningHub:image.largeFileWarning', '大文件警告')}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md">
            {t(
              'learningHub:image.largeFileDescription',
              '此图片较大 ({{size}})，加载可能需要较长时间并占用较多内存。是否继续加载？',
              { size: formatFileSize(fileSize) }
            )}
          </p>
        </div>
        <div className="flex gap-3 mt-2">
          <NotionButton
            variant="default"
            onClick={() => {
              onClose?.();
            }}
          >
            {t('common:cancel', '取消')}
          </NotionButton>
          <NotionButton
            variant="primary"
            onClick={() => {
              void loadImageContent();
            }}
          >
            {t('learningHub:image.loadAnyway', '继续加载')}
          </NotionButton>
        </div>
      </div>
    );
  }

  // 加载中
  if (loadingStage === 'loading') {
    const elapsed = loadStartTime > 0 ? Math.floor((Date.now() - loadStartTime) / 1000) : 0;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {t('learningHub:image.loading', '加载图片中...')}
          </p>
          {fileSize > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {formatFileSize(fileSize)}
              {elapsed > 2 && ` · ${elapsed}s`}
            </p>
          )}
        </div>
      </div>
    );
  }

  // 错误
  if (error || !imageUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <p>{error || t('learningHub:error.imageNotFound', '图片未找到')}</p>
        <NotionButton
          variant="default"
          size="sm"
          onClick={() => {
            void loadImageContent();
          }}
        >
          {t('common:retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  // ★ 2026-06-12（审阅问题 M2）：图片解码/渲染失败（典型如 WebView 不支持 HEIC）。
  // 旧实现没有 onError 处理，失败时只显示一个永远加载不出来的空白裂图。
  if (renderFailed) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
        <ImageBroken size={40} className="text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('learningHub:image.renderFailed', '图片无法显示')}
          </p>
          <p className="text-xs text-muted-foreground max-w-md">
            {isLikelyUnsupportedFormat
              ? t('learningHub:image.unsupportedFormatHint', '当前系统的内置浏览器不支持该格式（如 HEIC/HEIF）。可保存到本地后用系统图片查看器打开。')
              : t('learningHub:image.renderFailedHint', '图片数据可能已损坏或格式不受支持。可尝试保存到本地查看。')}
          </p>
        </div>
        <div className="flex gap-2">
          <NotionButton
            variant="default"
            size="sm"
            onClick={() => {
              void loadImageContent();
            }}
          >
            {t('common:retry', '重试')}
          </NotionButton>
          <NotionButton
            variant="primary"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              void handleSaveToDevice();
            }}
          >
            {isSaving ? <CircleNotch size={14} className="animate-spin" /> : <Download size={14} />}
            <span className="ml-1">{t('learningHub:image.saveToDevice', '保存到本地')}</span>
          </NotionButton>
        </div>
      </div>
    );
  }

  // ★ 旋转 90°/270° 的布局盒修正：CSS transform 只改视觉不改布局，
  // 直接 rotate 会让滚动区域仍按未旋转的宽高计算（裁切/多余空白）。
  // 已知自然尺寸与视口宽度时，显式计算旋转后的包围盒（box）尺寸，
  // 图片以绝对定位居中放入 box 再旋转，布局盒与视觉盒完全一致。
  const rotatedSideways = rotation % 180 !== 0;
  let rotatedBox: { boxW: number; boxH: number; imgW: number; imgH: number } | null = null;
  if (rotatedSideways && naturalSize && viewportSize && naturalSize.w > 0 && naturalSize.h > 0) {
    const availW = viewportSize.w - CONTENT_PADDING_PX * 2;
    if (availW > 0) {
      // 与未旋转语义一致：zoom% 表示"视觉宽度占容器可用宽度的比例"；
      // 100% 时保持自然尺寸但不超过容器（旋转后视觉宽度 = 图片自然高度）
      const visualW = zoom === 100 ? Math.min(naturalSize.h, availW) : (availW * zoom) / 100;
      const imgH = visualW;
      const imgW = (imgH * naturalSize.w) / naturalSize.h;
      rotatedBox = { boxW: imgH, boxH: imgW, imgW, imgH };
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏（移动端触控目标 ≥44px：max-md:min-h/min-w-11，桌面端不变） */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30" role="toolbar">
        <div className="flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomOut}
            disabled={zoom <= ZOOM_MIN}
            title={t('learningHub:image.zoomOut', '缩小')}
            aria-label={t('learningHub:image.zoomOut', '缩小')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <MagnifyingGlassMinus size={16} />
          </NotionButton>
          <span className="text-sm text-muted-foreground min-w-[4rem] text-center">
            {Math.round(zoom)}%
          </span>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomIn}
            disabled={zoom >= ZOOM_MAX}
            title={t('learningHub:image.zoomIn', '放大')}
            aria-label={t('learningHub:image.zoomIn', '放大')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <MagnifyingGlassPlus size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRotate}
            title={t('learningHub:image.rotate', '旋转')}
            aria-label={t('learningHub:image.rotate', '旋转')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <ArrowClockwise size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            title={t('learningHub:image.reset', '重置')}
            aria-label={t('learningHub:image.reset', '重置')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <ArrowsOut size={16} />
          </NotionButton>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate max-w-[200px]">{node.name}</span>
          {fileSize > 0 && (
            <span className="text-xs opacity-70">({formatFileSize(fileSize)})</span>
          )}
        </div>
      </div>

      {/* 图片区域：Ctrl+滚轮指针锚点缩放、拖拽/方向键平移、双击 100%↔200%、
          +/-/0/R/Esc 键盘操作。orientation="both" 允许放大后横向平移。
          居中布局放在滚动内容自己的 wrapper 上（viewportClassName 落在
          OverlayScrollbars host 上，flex 居中到不了图片的父级），
          子元素用 m-auto 居中：溢出时 auto margin 归零，边缘始终可滚动到达
          （justify-center + 溢出会让左/上边缘不可达）。 */}
      <CustomScrollArea
        className="flex-1 outline-none"
        viewportClassName="bg-muted/10"
        orientation="both"
        viewportRef={setViewportEl}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        role="group"
        aria-label={node.name}
      >
        <div
          className={`flex min-h-full min-w-full p-4 select-none ${
            isPanning ? 'cursor-grabbing' : isPannable ? 'cursor-grab' : ''
          }`}
          onPointerDown={handlePanPointerDown}
          onPointerMove={handlePanPointerMove}
          onPointerUp={handlePanPointerEnd}
          onPointerCancel={handlePanPointerEnd}
          onDoubleClick={handleDoubleClick}
        >
          {rotatedBox ? (
            <div
              className="relative flex-none m-auto"
              style={{ width: rotatedBox.boxW, height: rotatedBox.boxH }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt={node.name}
                className="absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: rotatedBox.imgW,
                  height: rotatedBox.imgH,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
                draggable={false}
                onLoad={handleImgLoad}
                onError={() => setRenderFailed(true)}
              />
            </div>
          ) : (
            /* flex-none：放大到超出容器时禁止 flex-shrink 把图片压回容器宽度 */
            <img
              ref={imgRef}
              src={imageUrl}
              alt={node.name}
              className="flex-none object-contain m-auto transition-transform duration-200"
              style={{
                width: zoom !== 100 ? `${zoom}%` : undefined,
                maxWidth: zoom > 100 ? 'none' : '100%',
                transform: rotation ? `rotate(${rotation}deg)` : undefined,
              }}
              draggable={false}
              onLoad={handleImgLoad}
              onError={() => setRenderFailed(true)}
            />
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default ImageContentView;
