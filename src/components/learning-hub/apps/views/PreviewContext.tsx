/**
 * 预览控制 Context
 *
 * 提供预览器的统一状态管理，包括缩放比例、字号比例等
 * 支持 docx、xlsx、pptx、image、text 等预览类型
 */

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type ReactNode,
} from 'react';

import {
  ZOOM_MIN,
  ZOOM_MAX,
  FONT_MIN,
  FONT_MAX,
  savePreviewPrefs,
  loadPreviewPrefs,
  clampNumber,
} from './previewUtils';

import type { PreviewType as FullPreviewType } from '@/components/notes/types/reference';

// ============================================================================
// 类型定义
// ============================================================================

/** 预览控制所支持的类型子集（从 reference.ts 的 canonical PreviewType 中提取） */
export type PreviewType = Extract<FullPreviewType, 'docx' | 'xlsx' | 'pptx' | 'image' | 'text'> | null;

/** 预览控制 Context 值类型 */
export interface PreviewContextValue {
  /** 缩放比例，默认 1 */
  zoomScale: number;
  /** 字号比例，默认 1，仅用于 docx/xlsx */
  fontScale: number;
  /** 当前预览类型 */
  previewType: PreviewType;
  /** 设置缩放比例 */
  setZoomScale: (scale: number) => void;
  /** 设置字号比例 */
  setFontScale: (scale: number) => void;
  /** 重置缩放为默认值 */
  resetZoom: () => void;
  /** 重置字号为默认值 */
  resetFont: () => void;
  /** 设置预览类型 */
  setPreviewType: (type: PreviewType) => void;
}

/** PreviewProvider 组件属性 */
export interface PreviewProviderProps {
  /** 子组件 */
  children: ReactNode;
  /** 初始预览类型 */
  initialPreviewType?: PreviewType;
  /** 初始缩放比例 */
  initialZoomScale?: number;
  /** 初始字号比例 */
  initialFontScale?: number;
}

// ============================================================================
// 默认值
// ============================================================================

/** 默认缩放比例 */
const DEFAULT_ZOOM_SCALE = 1;
/** 默认字号比例 */
const DEFAULT_FONT_SCALE = 1;

/** Context 默认值 */
const defaultContextValue: PreviewContextValue = {
  zoomScale: DEFAULT_ZOOM_SCALE,
  fontScale: DEFAULT_FONT_SCALE,
  previewType: null,
  setZoomScale: () => {},
  setFontScale: () => {},
  resetZoom: () => {},
  resetFont: () => {},
  setPreviewType: () => {},
};

// ============================================================================
// Context 创建
// ============================================================================

/** 预览控制 Context */
export const PreviewContext = createContext<PreviewContextValue>(defaultContextValue);

PreviewContext.displayName = 'PreviewContext';

// ============================================================================
// Hook
// ============================================================================

/**
 * 使用预览控制 Context 的 Hook
 *
 * @throws {Error} 在 PreviewProvider 外部使用时抛出错误
 * @returns PreviewContextValue
 *
 * @example
 * ```tsx
 * const { zoomScale, setZoomScale, resetZoom } = usePreviewContext();
 * ```
 */
export const usePreviewContext = (): PreviewContextValue => {
  const context = useContext(PreviewContext);

  if (context === defaultContextValue) {
    throw new Error('usePreviewContext 必须在 PreviewProvider 内部使用');
  }

  return context;
};

// ============================================================================
// Provider 组件
// ============================================================================

/**
 * 预览控制 Provider 组件
 *
 * 提供预览器状态管理，支持缩放比例和字号比例的持久化
 *
 * @example
 * ```tsx
 * <PreviewProvider initialPreviewType="docx">
 *   <DocxPreview />
 * </PreviewProvider>
 * ```
 */
export const PreviewProvider: React.FC<PreviewProviderProps> = ({
  children,
  initialPreviewType = null,
  initialZoomScale,
  initialFontScale,
}) => {
  // 预览类型状态
  const [previewType, setPreviewTypeState] = useState<PreviewType>(initialPreviewType);

  // 缩放比例状态（尝试从 localStorage 恢复）
  const [zoomScale, setZoomScaleState] = useState<number>(() => {
    // 优先使用传入的初始值
    if (initialZoomScale !== undefined) {
      return clampNumber(initialZoomScale, ZOOM_MIN, ZOOM_MAX);
    }
    // 尝试从 localStorage 恢复
    if (initialPreviewType && ['docx', 'xlsx', 'pptx'].includes(initialPreviewType)) {
      const prefs = loadPreviewPrefs(initialPreviewType as 'docx' | 'xlsx' | 'pptx');
      if (prefs?.zoomScale) {
        return prefs.zoomScale;
      }
    }
    return DEFAULT_ZOOM_SCALE;
  });

  // 字号比例状态（尝试从 localStorage 恢复，仅 docx/xlsx 使用）
  const [fontScale, setFontScaleState] = useState<number>(() => {
    // 优先使用传入的初始值
    if (initialFontScale !== undefined) {
      return clampNumber(initialFontScale, FONT_MIN, FONT_MAX);
    }
    // 尝试从 localStorage 恢复
    if (initialPreviewType && ['docx', 'xlsx'].includes(initialPreviewType)) {
      const prefs = loadPreviewPrefs(initialPreviewType as 'docx' | 'xlsx');
      if (prefs?.fontScale) {
        // 🔒 审计修复: 从 localStorage 恢复时也需 clamp（loadPreviewPrefs 现已验证，此处做防御性 clamp）
        return clampNumber(prefs.fontScale, FONT_MIN, FONT_MAX);
      }
    }
    return DEFAULT_FONT_SCALE;
  });

  // 设置缩放比例（仅更新状态，持久化由 useEffect 处理）
  const setZoomScale = useCallback((scale: number) => {
    const clampedScale = clampNumber(scale, ZOOM_MIN, ZOOM_MAX);
    setZoomScaleState(clampedScale);
  }, []);

  // 设置字号比例（仅更新状态，持久化由 useEffect 处理）
  const setFontScale = useCallback((scale: number) => {
    const clampedScale = clampNumber(scale, FONT_MIN, FONT_MAX);
    setFontScaleState(clampedScale);
  }, []);

  // 重置缩放为默认值
  const resetZoom = useCallback(() => {
    setZoomScaleState(DEFAULT_ZOOM_SCALE);
  }, []);

  // 重置字号为默认值
  const resetFont = useCallback(() => {
    setFontScaleState(DEFAULT_FONT_SCALE);
  }, []);

  // 使用 ref 跟踪是否为首次渲染（避免初始化时触发持久化）
  const isInitialMount = useRef(true);

  // 统一处理偏好持久化（避免闭包问题）
  useEffect(() => {
    // 跳过首次渲染
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    // 持久化到 localStorage
    if (previewType && ['docx', 'xlsx', 'pptx'].includes(previewType)) {
      savePreviewPrefs(previewType as 'docx' | 'xlsx' | 'pptx', {
        zoomScale,
        fontScale: ['docx', 'xlsx'].includes(previewType) ? fontScale : undefined,
      });
    }
  }, [previewType, zoomScale, fontScale]);

  // 设置预览类型（切换时从 localStorage 恢复对应偏好）
  const setPreviewType = useCallback((type: PreviewType) => {
    setPreviewTypeState(type);

    // 切换预览类型时，尝试恢复该类型的偏好设置
    if (type && ['docx', 'xlsx', 'pptx'].includes(type)) {
      const prefs = loadPreviewPrefs(type as 'docx' | 'xlsx' | 'pptx');
      if (prefs) {
        setZoomScaleState(prefs.zoomScale);
        if (prefs.fontScale && ['docx', 'xlsx'].includes(type)) {
          // 🔒 审计修复: 切换预览类型时也 clamp fontScale
          setFontScaleState(clampNumber(prefs.fontScale, FONT_MIN, FONT_MAX));
        }
      } else {
        // 无偏好时重置为默认值
        setZoomScaleState(DEFAULT_ZOOM_SCALE);
        setFontScaleState(DEFAULT_FONT_SCALE);
      }
    } else {
      // 非文档类型时重置为默认值
      setZoomScaleState(DEFAULT_ZOOM_SCALE);
      setFontScaleState(DEFAULT_FONT_SCALE);
    }
  }, []);

  // 使用 useMemo 缓存 Context 值，避免不必要的重渲染
  const contextValue = useMemo<PreviewContextValue>(
    () => ({
      zoomScale,
      fontScale,
      previewType,
      setZoomScale,
      setFontScale,
      resetZoom,
      resetFont,
      setPreviewType,
    }),
    [
      zoomScale,
      fontScale,
      previewType,
      setZoomScale,
      setFontScale,
      resetZoom,
      resetFont,
      setPreviewType,
    ]
  );

  return (
    <PreviewContext.Provider value={contextValue}>
      {children}
    </PreviewContext.Provider>
  );
};

PreviewProvider.displayName = 'PreviewProvider';

// ============================================================================
// 导出常量（便于外部使用）
// ============================================================================

export { ZOOM_MIN, ZOOM_MAX, FONT_MIN, FONT_MAX } from './previewUtils';
export { DEFAULT_ZOOM_SCALE, DEFAULT_FONT_SCALE };
