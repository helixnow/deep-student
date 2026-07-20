/**
 * 图片内容视图
 *
 * 用于在 Learning Hub 中预览图片附件。
 * 支持缩放、旋转、拖拽平移、键盘操作等功能。
 *
 * ★ 2026-02 优化：渐进式加载支持
 * - 小文件（< 20MB）：直接加载
 * - 大文件（>= 20MB）：显示警告，用户确认后加载
 * - 添加加载进度指示
 *
 * ★ 2026-07 优化：交互与生命周期
 * - Ctrl/Cmd + 滚轮缩放改用原生非 passive 监听（React onWheel 无法 preventDefault，
 *   会同时触发 WebView 页面缩放）
 * - 缩放锚点：滚轮/双击缩放锚定指针位置，按钮/键盘缩放锚定视口中心
 *   （基于缩放前后 getBoundingClientRect 实测，天然兼容旋转与 padding）
 * - 拖拽平移（pointer capture，仅鼠标；触摸沿用原生滚动），grab/grabbing 光标
 * - 旋转 90°/270° 时按自然尺寸计算包围盒，布局盒与视觉盒完全一致
 * - 加载竞态防护（切换节点时丢弃过期结果并 revoke ObjectURL，避免泄漏）
 *
 * ★ 2026-07 二期：缩放语义重构（对标 macOS Preview）
 * - 明确两种模式：「适应窗口 Fit」（默认，窗口 resize 自动跟随，不放大小图）
 *   与「实际像素 1:1」；百分比一律基于图片实际像素（100% = 原始尺寸）
 * - 工具栏：Fit/1:1 切换按钮、百分比档位菜单（Popover）、旋转、重置
 * - 双击智能切换：当前≈Fit → 放大到 1:1（图比窗口小则 200%）；否则回 Fit
 * - 加载优先走 vfs_get_file_blob_path + read_file_bytes（ArrayBuffer，
 *   省去 base64 双份驻留），失败回退 vfs_get_attachment_content base64
 * - 键盘：+/- 缩放、0 重置（Fit）、1 实际大小、R 旋转、方向键平移、Esc 重置
 * - 透明格式（PNG/WebP/GIF/SVG/AVIF）棋盘格衬底；旋转短过渡动画（累计角度，
 *   永远正向旋转）；解码期 shimmer 占位；均支持 reduced-motion 降级
 */

import React, { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowsIn,
  FrameCorners,
  CaretDown,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';

import { base64ToBlob, base64ToUint8Array } from '@/utils/base64FileUtils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { formatFileSize } from './previewUtils';
import { PreviewStatus } from './PreviewStatus';

/** 图片大文件确认阈值（后端图片上限 50MB；超过 20MB 先提示再加载） */
const IMAGE_LARGE_FILE_THRESHOLD = 20 * 1024 * 1024;

/** 手动缩放下限（%，实际像素比例；Fit 比例更小时以 Fit 为下限） */
const ZOOM_MIN = 10;
const ZOOM_MAX = 800;
/** 按钮/键盘缩放的吸附档位（%，实际像素比例） */
const ZOOM_LEVELS = [10, 25, 50, 75, 100, 125, 150, 200, 300, 400, 600, 800];
/** 百分比档位菜单的预设项 */
const ZOOM_PRESETS = [50, 100, 200, 400];
/** 双击放大的目标倍率（图比窗口小时使用） */
const ZOOM_DOUBLE_CLICK = 200;
/** 方向键平移步长（px） */
const PAN_STEP = 48;
/** 图片区 wrapper 的 p-4 内边距（px，Tailwind 默认 1rem=16px） */
const CONTENT_PADDING_PX = 16;

/** 透明图棋盘格衬底（语义 token，浅/深主题自适应） */
const CHECKERBOARD_STYLE: React.CSSProperties = {
  backgroundImage:
    'conic-gradient(hsl(var(--muted)) 90deg, transparent 90deg 180deg, hsl(var(--muted)) 180deg 270deg, transparent 270deg)',
  backgroundSize: '16px 16px',
};

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
 * 计算 Fit（适应窗口）模式的实际像素缩放比例（%）。
 * 语义与 macOS Preview 一致：完整装入视口，但不放大小图（上限 100%）。
 * 旋转 90°/270° 时视觉宽高互换。
 */
const computeFitZoom = (
  natural: Size | null,
  viewport: Size | null,
  rotation: number
): number => {
  if (!natural || !viewport || natural.w <= 0 || natural.h <= 0) return 100;
  const availW = viewport.w - CONTENT_PADDING_PX * 2;
  const availH = viewport.h - CONTENT_PADDING_PX * 2;
  if (availW <= 0 || availH <= 0) return 100;
  const sideways = rotation % 180 !== 0;
  const visualW = sideways ? natural.h : natural.w;
  const visualH = sideways ? natural.w : natural.h;
  const scale = Math.min(availW / visualW, availH / visualH, 1);
  return Math.max(scale * 100, 0.5);
};

/**
 * 图片内容视图组件
 */
const ImageContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);

  // 状态
  // ★ 缩放语义：manualZoom 为"实际像素比例"（100 = 1:1 原始尺寸），仅在
  //   fitMode=false 时生效；fitMode=true 时实际比例由视口/自然尺寸实时推导。
  //   允许小数：滚轮/捏合的小步进若强制取整，低倍率下会被 round 吞掉。
  const [fitMode, setFitMode] = useState(true);
  const [manualZoom, setManualZoom] = useState(100);
  // ★ rotation 为累计角度（不取模）：CSS transform 过渡永远正向旋转 90°，
  //   避免 270→0 时倒转 270° 的视觉抖动。布局计算处取 % 360。
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
  // 图片自然尺寸（缩放/旋转包围盒计算依赖）与视口尺寸（随窗口变化）
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [viewportSize, setViewportSize] = useState<Size | null>(null);
  // 拖拽平移状态
  const [isPanning, setIsPanning] = useState(false);
  const [isPannable, setIsPannable] = useState(false);
  // 百分比档位菜单
  const [zoomMenuOpen, setZoomMenuOpen] = useState(false);

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
  const zoomMenuWrapRef = useRef<HTMLDivElement | null>(null);

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
  // 可能带透明通道的格式：加棋盘格衬底
  const canBeTransparent = /png|webp|gif|svg|avif/i.test(mimeType);
  // 信息条格式标签：优先 MIME 子类型，回退文件扩展名
  const formatLabel = useMemo(() => {
    const sub = mimeType.split('/')[1]?.split('+')[0];
    if (sub) return sub.toUpperCase();
    const ext = node.name.includes('.') ? node.name.split('.').pop() : '';
    return (ext || '').toUpperCase();
  }, [mimeType, node.name]);

  // ★ 派生的实际缩放比例（%，实际像素）。Fit 模式随视口/旋转实时变化，
  //   窗口 resize 自动跟随；手动模式使用 manualZoom。
  const normalizedRotation = ((rotation % 360) + 360) % 360;
  const fitZoom = useMemo(
    () => computeFitZoom(naturalSize, viewportSize, normalizedRotation),
    [naturalSize, viewportSize, normalizedRotation]
  );
  const effectiveZoom = fitMode ? fitZoom : manualZoom;
  // refs：供稳定回调（原生滚轮/触摸监听）读取最新值，避免频繁重绑监听器
  const effectiveZoomRef = useRef(effectiveZoom);
  effectiveZoomRef.current = effectiveZoom;
  const fitZoomRef = useRef(fitZoom);
  fitZoomRef.current = fitZoom;

  // ObjectURL 统一释放（所有替换/重置路径都必须经过这里，否则 Blob 常驻内存）
  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  // 清理 ObjectURL + 使未完成的加载失效
  useEffect(() => {
    return () => {
      loadGenRef.current += 1;
      releaseObjectUrl();
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, [releaseObjectUrl]);

  // 加载图片内容的核心函数
  // ★ 优先路径：vfs_get_file_blob_path + read_file_bytes（原始 ArrayBuffer，
  //   免 base64 编解码与双份驻留）；任一环节失败回退 base64 路径。
  const loadImageContent = useCallback(async () => {
    const gen = ++loadGenRef.current;
    setLoadingStage('loading');
    setLoadStartTime(Date.now());
    setError(null);
    setRenderFailed(false);

    try {
      let blob: Blob | null = null;

      // 1) blob 文件直读（仅 files 表节点有 blob_hash；att_ 附件返回 null 走回退）
      try {
        const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: node.id });
        if (gen !== loadGenRef.current) return;
        if (blobPath) {
          const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: blobPath });
          if (gen !== loadGenRef.current) return;
          if (buffer && buffer.byteLength > 0) {
            blob = new Blob([buffer], { type: mimeType });
          }
        }
      } catch {
        // 直读失败不视为错误，回退 base64 路径
      }
      if (gen !== loadGenRef.current) return;

      // 2) 回退：附件内容 base64
      if (!blob) {
        const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
          attachmentId: node.id,
        });

        // ★ 结果已过期（节点已切换或组件已卸载）：直接丢弃，不创建 ObjectURL
        if (gen !== loadGenRef.current) return;

        if (result.found && result.content) {
          blob = base64ToBlob(result.content, mimeType);
          if (!blob) {
            setError(t('learningHub:error.imageDecodeFailed'));
            setLoadingStage('idle');
            return;
          }
        } else {
          setError(t('learningHub:error.imageNotFound'));
          setLoadingStage('idle');
          return;
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      releaseObjectUrl();
      objectUrlRef.current = objectUrl;
      setImageUrl(objectUrl);
      setLoadingStage('done');
    } catch (err: unknown) {
      if (gen !== loadGenRef.current) return;
      setError(getErrorMessage(err));
      setLoadingStage('idle');
    }
  }, [node.id, mimeType, t, releaseObjectUrl]);

  // ★ 保存到本地（渲染失败/大文件场景的逃生通道）
  const handleSaveToDevice = useCallback(async () => {
    setIsSaving(true);
    try {
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      if (!result?.found || !result?.content) {
        showGlobalNotification('error', t('learningHub:error.imageNotFound'));
        return;
      }
      const bytes = base64ToUint8Array(result.content);
      if (!bytes) {
        showGlobalNotification('error', t('learningHub:error.imageDecodeFailed'));
        return;
      }
      const ext = node.name.includes('.') ? node.name.split('.').pop() || '' : '';
      const saveResult = await fileManager.saveBinaryFile({
        data: bytes,
        defaultFileName: node.name,
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });
      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully'));
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
      // ★ 切换到新节点时重置视图状态，避免沿用上一张图的缩放/旋转/错误；
      //   旧 ObjectURL 必须在此 revoke——仅 setImageUrl(null) 会让 Blob 泄漏。
      //   未消费的缩放锚点也要丢弃：上一张图在极值处缩放（manualZoom 被 clamp
      //   为原值）会留下 anchor，切换节点后 effectiveZoom 必变，layout effect
      //   会拿旧图坐标去滚动新图。
      releaseObjectUrl();
      zoomAnchorRef.current = null;
      setLoadingStage('checking');
      setError(null);
      setRenderFailed(false);
      setImageUrl(null);
      setNaturalSize(null);
      setFitMode(true);
      setManualZoom(100);
      setRotation(0);
      setZoomMenuOpen(false);

      try {
        // 先获取附件元数据
        const attachment = await invoke<VfsAttachment | null>('vfs_get_attachment', {
          attachmentId: node.id,
        });

        if (gen !== loadGenRef.current) return;

        if (!attachment) {
          setError(t('learningHub:error.imageNotFound'));
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
  }, [node.id, t, loadImageContent, releaseObjectUrl]);

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

  // ★ 设定手动缩放（退出 Fit 模式），锚定指定坐标或视口中心。
  //   下限取 min(ZOOM_MIN, fitZoom)：超大图 Fit 可能低于 10%，缩回 Fit 不应被卡住。
  const applyZoom = useCallback((target: number, clientX?: number, clientY?: number) => {
    captureZoomAnchor(clientX, clientY);
    const min = Math.min(ZOOM_MIN, fitZoomRef.current);
    setManualZoom(Math.max(min, Math.min(ZOOM_MAX, target)));
    setFitMode(false);
  }, [captureZoomAnchor]);

  // ★ 进入 Fit 模式：内容完整装入视口，无需锚点回填
  const enterFitMode = useCallback(() => {
    zoomAnchorRef.current = null;
    setFitMode(true);
  }, []);

  // 缩放控制（按钮/键盘：沿档位阶梯步进，滚轮的中间值吸附到最近档位）
  const handleZoomIn = useCallback(() => {
    const cur = effectiveZoomRef.current;
    const next = ZOOM_LEVELS.find((level) => level > cur + 0.5) ?? ZOOM_MAX;
    applyZoom(next);
  }, [applyZoom]);

  const handleZoomOut = useCallback(() => {
    const cur = effectiveZoomRef.current;
    const prev = [...ZOOM_LEVELS].reverse().find((level) => level < cur - 0.5);
    applyZoom(prev ?? Math.min(ZOOM_MIN, fitZoomRef.current));
  }, [applyZoom]);

  const handleActualSize = useCallback(() => {
    applyZoom(100);
  }, [applyZoom]);

  const handleRotate = useCallback(() => {
    setRotation((prev) => prev + 90);
  }, []);

  const handleReset = useCallback(() => {
    enterFitMode();
    setManualZoom(100);
    // 正向补齐到最近的整周，过渡动画不倒转
    setRotation((prev) => (prev % 360 === 0 ? prev : prev + (360 - (prev % 360))));
  }, [enterFitMode]);

  // ★ 双击智能切换：当前≈Fit → 放大（图比窗口小则 200%，否则 1:1）；否则回 Fit
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const fitZ = fitZoomRef.current;
    const cur = effectiveZoomRef.current;
    if (Math.abs(cur - fitZ) < 1) {
      applyZoom(fitZ < 99.5 ? 100 : ZOOM_DOUBLE_CLICK, e.clientX, e.clientY);
    } else {
      enterFitMode();
    }
  }, [applyZoom, enterFitMode]);

  // ★ 缩放后按锚点回填滚动位置（useLayoutEffect：布局已更新、尚未绘制，无闪跳）。
  // 无锚点（如切换节点重置/进入 Fit）时跳过，浏览器自行钳制滚动。
  const prevZoomRef = useRef(effectiveZoom);
  useLayoutEffect(() => {
    if (prevZoomRef.current === effectiveZoom) return;
    prevZoomRef.current = effectiveZoom;
    const anchor = zoomAnchorRef.current;
    zoomAnchorRef.current = null;
    const vp = viewportElRef.current;
    const img = imgRef.current;
    if (!anchor || !vp || !img) return;
    const rect = img.getBoundingClientRect();
    vp.scrollLeft += rect.left + anchor.fx * rect.width - anchor.cx;
    vp.scrollTop += rect.top + anchor.fy * rect.height - anchor.cy;
  }, [effectiveZoom]);

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
  }, [effectiveZoom, rotation, viewportSize, naturalSize, imageUrl]);

  // ★ Ctrl/Cmd + 滚轮缩放（含触控板捏合，浏览器上报为 ctrl+wheel），锚定指针位置。
  // 必须用原生非 passive 监听：React 的 onWheel 是 passive 的，
  // preventDefault 无效，会同时触发 WebView 页面级缩放。
  const handleNativeWheel = useCallback((e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // 按 deltaY 指数缩放：鼠标滚轮一格约 ±18%，触控板捏合的小 delta 平滑连续
    const factor = Math.exp(-e.deltaY * 0.002);
    applyZoom(effectiveZoomRef.current * factor, e.clientX, e.clientY);
  }, [applyZoom]);

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
    applyZoom(
      effectiveZoomRef.current * factor,
      (a.clientX + b.clientX) / 2,
      (a.clientY + b.clientY) / 2
    );
  }, [applyZoom]);
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

  // ★ 键盘操作：+/- 缩放、0 重置（Fit）、1 实际大小、R 旋转、方向键平移、Esc 重置
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
      case '1':
        e.preventDefault();
        handleActualSize();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        handleRotate();
        break;
      case 'Escape':
        // 有变换时先重置；未变换时不拦截，让上层处理（如关闭面板）
        if (!fitMode || rotation % 360 !== 0) {
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
  }, [fitMode, rotation, handleZoomIn, handleZoomOut, handleReset, handleActualSize, handleRotate]);

  const handleImgLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    // ★ 无固有尺寸的 SVG（无 width/height/viewBox）naturalWidth/Height 为 0，
    //   不兜底会让 displayBox 永远为 null、卡在 shimmer 占位上
    const w = e.currentTarget.naturalWidth || 512;
    const h = e.currentTarget.naturalHeight || 512;
    setNaturalSize((prev) =>
      prev && prev.w === w && prev.h === h ? prev : { w, h }
    );
  }, []);

  // ★ 百分比档位菜单：点击外部关闭（轻量 Popover，非模态、无遮罩）
  useEffect(() => {
    if (!zoomMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!zoomMenuWrapRef.current?.contains(e.target as Node)) {
        setZoomMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [zoomMenuOpen]);

  const selectZoomPreset = useCallback((preset: number | 'fit') => {
    setZoomMenuOpen(false);
    if (preset === 'fit') {
      enterFitMode();
    } else {
      applyZoom(preset);
    }
  }, [applyZoom, enterFitMode]);

  // 检查文件大小中
  if (loadingStage === 'checking') {
    return (
      <PreviewStatus
        tone="loading"
        title={t('learningHub:image.checkingSize')}
      />
    );
  }

  // 大文件警告
  if (loadingStage === 'large_file_warning') {
    return (
      <PreviewStatus
        tone="warning"
        title={t('learningHub:image.largeFileWarning')}
        description={t('learningHub:image.largeFileDescription', { size: formatFileSize(fileSize) })}
        actions={[
          {
            id: 'cancel',
            label: t('common:cancel'),
            onClick: () => { onClose?.(); },
            variant: 'default',
          },
          {
            id: 'loadAnyway',
            label: t('learningHub:image.loadAnyway'),
            onClick: () => { void loadImageContent(); },
            variant: 'primary',
          },
        ]}
      />
    );
  }

  // 加载中
  if (loadingStage === 'loading') {
    const elapsed = loadStartTime > 0 ? Math.floor((Date.now() - loadStartTime) / 1000) : 0;
    return (
      <PreviewStatus
        tone="loading"
        title={t('learningHub:image.loading')}
        description={
          fileSize > 0
            ? `${formatFileSize(fileSize)}${elapsed > 2 ? ` · ${elapsed}s` : ''}`
            : undefined
        }
      />
    );
  }

  // 错误
  if (error || !imageUrl) {
    return (
      <PreviewStatus
        tone="error"
        icon="warning"
        title={error || t('learningHub:error.imageNotFound')}
        actions={[
          {
            id: 'retry',
            label: t('common:retry'),
            onClick: () => { void loadImageContent(); },
            variant: 'default',
          },
        ]}
      />
    );
  }

  // ★ 2026-06-12（审阅问题 M2）：图片解码/渲染失败（典型如 WebView 不支持 HEIC）。
  // 旧实现没有 onError 处理，失败时只显示一个永远加载不出来的空白裂图。
  if (renderFailed) {
    return (
      <PreviewStatus
        tone="error"
        icon="brokenImage"
        title={t('learningHub:image.renderFailed')}
        description={
          isLikelyUnsupportedFormat
            ? t('learningHub:image.unsupportedFormatHint')
            : t('learningHub:image.renderFailedHint')
        }
        actions={[
          {
            id: 'retry',
            label: t('common:retry'),
            onClick: () => { void loadImageContent(); },
            variant: 'default',
          },
          {
            id: 'save',
            label: t('learningHub:image.saveToDevice'),
            onClick: () => { void handleSaveToDevice(); },
            variant: 'primary',
            loading: isSaving,
            disabled: isSaving,
          },
        ]}
      />
    );
  }

  // ★ 显示尺寸统一按"实际像素 × 缩放比例"显式计算（Fit 与手动共用一条路径）。
  // CSS transform 只改视觉不改布局：旋转 90°/270° 时包围盒宽高互换，
  // 图片以绝对定位居中放入 box 再旋转，布局盒与视觉盒完全一致。
  const rotatedSideways = normalizedRotation % 180 !== 0;
  let displayBox: { boxW: number; boxH: number; imgW: number; imgH: number } | null = null;
  if (naturalSize && naturalSize.w > 0 && naturalSize.h > 0) {
    const scale = effectiveZoom / 100;
    const imgW = naturalSize.w * scale;
    const imgH = naturalSize.h * scale;
    displayBox = rotatedSideways
      ? { boxW: imgH, boxH: imgW, imgW, imgH }
      : { boxW: imgW, boxH: imgH, imgW, imgH };
  }

  const displayZoom = Math.round(effectiveZoom);
  const minZoom = Math.min(ZOOM_MIN, fitZoom);
  const isActualSize = !fitMode && Math.abs(manualZoom - 100) < 0.5;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏（移动端触控目标 ≥44px：max-md:min-h/min-w-11，桌面端不变） */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b bg-muted/30"
        role="toolbar"
        aria-label={t('learningHub:image.toolbarLabel')}
      >
        <div className="flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomOut}
            disabled={effectiveZoom <= minZoom + 0.5}
            title={t('learningHub:image.zoomOut')}
            aria-label={t('learningHub:image.zoomOut')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <MagnifyingGlassMinus size={16} />
          </NotionButton>
          {/* 百分比 = 实际像素比例（100% 即 1:1）；点击展开档位菜单 */}
          <div
            ref={zoomMenuWrapRef}
            className="relative"
            onKeyDown={(e) => {
              if (e.key === 'Escape' && zoomMenuOpen) {
                e.stopPropagation();
                setZoomMenuOpen(false);
              }
            }}
          >
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => setZoomMenuOpen((prev) => !prev)}
              title={t('learningHub:image.zoomLevel')}
              aria-label={t('learningHub:image.zoomLevel')}
              aria-haspopup="menu"
              aria-expanded={zoomMenuOpen}
              className="min-w-[4.5rem] gap-1 tabular-nums text-muted-foreground max-md:min-h-11"
            >
              {displayZoom}%
              <CaretDown size={10} aria-hidden="true" />
            </NotionButton>
            {zoomMenuOpen && (
              <div
                role="menu"
                className="ui-zoom-fade-in absolute left-1/2 top-full z-50 mt-1 min-w-[8rem] -translate-x-1/2 rounded-[var(--radius-shell-control)] border bg-popover py-1 text-popover-foreground shadow-md"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="w-full px-3 py-1.5 text-left text-sm transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  onClick={() => selectZoomPreset('fit')}
                >
                  {t('learningHub:image.fitToWindow')}
                </button>
                <div className="my-1 h-px bg-border" aria-hidden="true" />
                {ZOOM_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    role="menuitem"
                    className="w-full px-3 py-1.5 text-left text-sm tabular-nums transition-colors duration-150 hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                    onClick={() => selectZoomPreset(preset)}
                  >
                    {preset}%
                  </button>
                ))}
              </div>
            )}
          </div>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomIn}
            disabled={effectiveZoom >= ZOOM_MAX - 0.5}
            title={t('learningHub:image.zoomIn')}
            aria-label={t('learningHub:image.zoomIn')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <MagnifyingGlassPlus size={16} />
          </NotionButton>
          <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={enterFitMode}
            title={t('learningHub:image.fitToWindow')}
            aria-label={t('learningHub:image.fitToWindow')}
            aria-pressed={fitMode}
            className={`max-md:min-h-11 max-md:min-w-11 ${fitMode ? 'bg-muted text-foreground' : ''}`}
          >
            <ArrowsIn size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleActualSize}
            title={t('learningHub:image.actualSize')}
            aria-label={t('learningHub:image.actualSize')}
            aria-pressed={isActualSize}
            className={`max-md:min-h-11 max-md:min-w-11 ${isActualSize ? 'bg-muted text-foreground' : ''}`}
          >
            <FrameCorners size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRotate}
            title={t('learningHub:image.rotate')}
            aria-label={t('learningHub:image.rotate')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <ArrowClockwise size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            title={t('learningHub:image.reset')}
            aria-label={t('learningHub:image.reset')}
            className="max-md:min-h-11 max-md:min-w-11"
          >
            <ArrowCounterClockwise size={16} />
          </NotionButton>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate max-w-[200px]">{node.name}</span>
        </div>
      </div>

      {/* 图片区域：Ctrl+滚轮指针锚点缩放、拖拽/方向键平移、双击 Fit↔放大、
          +/-/0/1/R/Esc 键盘操作。orientation="both" 允许放大后横向平移。
          居中布局放在滚动内容自己的 wrapper 上（viewportClassName 落在
          OverlayScrollbars host 上，flex 居中到不了图片的父级），
          子元素用 m-auto 居中：溢出时 auto margin 归零，边缘始终可滚动到达
          （justify-center + 溢出会让左/上边缘不可达）。 */}
      <CustomScrollArea
        className="flex-1 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40"
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
          {displayBox ? (
            /* flex-none：放大到超出容器时禁止 flex-shrink 把包围盒压回容器内。
               ui-fade-in：解码完成后淡入（reduced-motion 自动降级）。
               透明格式衬棋盘格，box 即视觉边界（含旋转）。 */
            <div
              className="relative flex-none m-auto ui-fade-in"
              style={{
                width: displayBox.boxW,
                height: displayBox.boxH,
                ...(canBeTransparent ? CHECKERBOARD_STYLE : null),
              }}
            >
              <img
                ref={imgRef}
                src={imageUrl}
                alt={node.name}
                className="absolute left-1/2 top-1/2 max-w-none transition-transform duration-150 motion-reduce:transition-none"
                style={{
                  width: displayBox.imgW,
                  height: displayBox.imgH,
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
                draggable={false}
                onLoad={handleImgLoad}
                onError={() => setRenderFailed(true)}
              />
            </div>
          ) : (
            /* 解码中：shimmer 占位 + 隐藏 img 触发 onLoad 取得自然尺寸 */
            <div className="relative flex-none m-auto">
              <div
                className="h-28 w-40 rounded-[var(--radius-shell-control)] bg-muted/40 animate-pulse motion-reduce:animate-none"
                aria-hidden="true"
              />
              <img
                ref={imgRef}
                src={imageUrl}
                alt={node.name}
                className="absolute inset-0 h-full w-full opacity-0 pointer-events-none"
                draggable={false}
                onLoad={handleImgLoad}
                onError={() => setRenderFailed(true)}
              />
            </div>
          )}
        </div>
      </CustomScrollArea>

      {/* 图片信息条：尺寸 / 格式 / 文件大小（常驻底部细条） */}
      {naturalSize && (
        <div
          className="flex items-center justify-center gap-2 border-t bg-muted/30 px-4 py-1 text-[11px] tabular-nums text-muted-foreground"
          role="group"
          aria-label={t('learningHub:image.imageInfo')}
        >
          <span>{naturalSize.w} × {naturalSize.h}</span>
          {formatLabel && (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatLabel}</span>
            </>
          )}
          {fileSize > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatFileSize(fileSize)}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default ImageContentView;
