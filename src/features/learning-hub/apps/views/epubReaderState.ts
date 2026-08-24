/**
 * EPUB 阅读器状态纯函数
 *
 * - localStorage 负责本机偏好与精细位置（主题/字号/章内滚动进度）；
 * - 资源 metadata（readingProgress 进度通道）负责跨设备的章节级进度：
 *   page = 章节序号（1-based），经 previewPersistence 控制器落库。
 * - 恢复时合并两个来源：章节一致时保留本机章内滚动位置；
 *   不一致且 metadata 带可用时间戳时取更新的一侧；当前后端只回读 page，
 *   无时间戳时以跨设备 metadata 为准（metadata 侧从章首开始）。
 */

export type EpubReaderTheme = 'light' | 'sepia' | 'dark' | 'app';
export type EpubReaderFontFamilyOption = 'book' | 'serif' | 'sans';

export const EPUB_MIN_FONT_SCALE = 0.75;
export const EPUB_MAX_FONT_SCALE = 1.8;
export const EPUB_DEFAULT_LINE_HEIGHT = 1.75;
export const EPUB_MIN_LINE_HEIGHT = 1.3;
export const EPUB_MAX_LINE_HEIGHT = 2.2;
export const EPUB_DEFAULT_PAGE_MARGIN = 0.4;

export interface PersistedEpubReaderState {
  chapterIndex: number;
  chapterProgress: number;
  theme: EpubReaderTheme;
  fontScale: number;
  fontFamily: EpubReaderFontFamilyOption;
  lineHeight: number;
  pageMargin: number;
  /** 本机最后写入时间（旧 payload 无此字段 → 0，跨设备合并时视为更旧） */
  updatedAt: number;
}

/**
 * 解析 localStorage 里的阅读器状态。每个字段独立回退：
 * 旧版本 payload（只有 chapterIndex/chapterProgress/theme/fontScale）仍可加载。
 */
export function parseEpubReaderState(raw: string | null): PersistedEpubReaderState {
  const fallback: PersistedEpubReaderState = {
    chapterIndex: 0,
    chapterProgress: 0,
    theme: 'light',
    fontScale: 1,
    fontFamily: 'book',
    lineHeight: EPUB_DEFAULT_LINE_HEIGHT,
    pageMargin: EPUB_DEFAULT_PAGE_MARGIN,
    updatedAt: 0,
  };
  try {
    const value = JSON.parse(raw ?? '{}') as Partial<PersistedEpubReaderState>;
    const pageMargin = Number(value.pageMargin);
    const updatedAt = Number(value.updatedAt);
    return {
      chapterIndex: Math.max(0, Math.floor(Number(value.chapterIndex) || 0)),
      chapterProgress: Math.min(1, Math.max(0, Number(value.chapterProgress) || 0)),
      theme:
        value.theme === 'dark' || value.theme === 'sepia' || value.theme === 'app'
          ? value.theme
          : 'light',
      fontScale: Math.min(
        EPUB_MAX_FONT_SCALE,
        Math.max(EPUB_MIN_FONT_SCALE, Number(value.fontScale) || 1),
      ),
      fontFamily:
        value.fontFamily === 'serif' || value.fontFamily === 'sans' ? value.fontFamily : 'book',
      lineHeight: Math.min(
        EPUB_MAX_LINE_HEIGHT,
        Math.max(EPUB_MIN_LINE_HEIGHT, Number(value.lineHeight) || EPUB_DEFAULT_LINE_HEIGHT),
      ),
      pageMargin: Number.isFinite(pageMargin)
        ? Math.min(1, Math.max(0, pageMargin))
        : EPUB_DEFAULT_PAGE_MARGIN,
      updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0,
    };
  } catch {
    return fallback;
  }
}

export interface EpubReadingLocation {
  chapterIndex: number;
  chapterProgress: number;
}

/**
 * 合并本机 localStorage 状态与资源 metadata 的章节级进度：
 * - metadata 无有效 page → 本机状态；
 * - 章节一致 → 本机状态（保留章内滚动位置）；
 * - 章节不一致：
 *   - metadata 有有效 lastReadAt → 时间戳更新的一侧赢；
 *   - metadata 无 lastReadAt → metadata 赢。当前 DSTU 后端只持久化/回读
 *     readingProgress.page，不能用本机 updatedAt 把跨设备章节永久挡掉。
 * metadata 赢时从章首开始。
 */
export function resolveInitialEpubLocation(
  local: Pick<PersistedEpubReaderState, 'chapterIndex' | 'chapterProgress' | 'updatedAt'>,
  metadataProgress?: { page?: number; lastReadAt?: number } | null,
): EpubReadingLocation {
  const localLocation = {
    chapterIndex: local.chapterIndex,
    chapterProgress: local.chapterProgress,
  };
  const metaPage = metadataProgress?.page;
  if (typeof metaPage !== 'number' || !Number.isFinite(metaPage) || metaPage < 1) {
    return localLocation;
  }
  const metaChapterIndex = Math.floor(metaPage) - 1;
  if (metaChapterIndex === local.chapterIndex) {
    return localLocation;
  }
  const localAt = local.updatedAt || 0;
  const metaAt = metadataProgress?.lastReadAt;
  if (typeof metaAt !== 'number' || !Number.isFinite(metaAt) || metaAt <= 0) {
    return { chapterIndex: metaChapterIndex, chapterProgress: 0 };
  }
  if (metaAt >= localAt) {
    return { chapterIndex: metaChapterIndex, chapterProgress: 0 };
  }
  return localLocation;
}

/** 章节级进度 → readingProgress 进度通道载荷（page 为 1-based 章节序号） */
export function buildEpubReadingProgress(chapterIndex: number): {
  page: number;
  lastReadAt: number;
} {
  return {
    page: Math.max(0, Math.floor(chapterIndex)) + 1,
    lastReadAt: Date.now(),
  };
}
