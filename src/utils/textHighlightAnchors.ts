/**
 * 阅读材料双锚点（W3C TextPositionSelector + TextQuoteSelector）文字高亮定位
 * 与智能触控笔/手掌拒绝（Palm Rejection）输入仲裁器。
 */

export type MaterialFormat = 'pdf' | 'docx' | 'markdown' | 'html';

export interface MaterialTextAnchor {
  format: MaterialFormat;
  pageOrSegment: number;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
  contentSignature: string;
}

export interface CreateTextHighlightAnchorMeta {
  format: MaterialFormat;
  pageOrSegment: number;
  contentSignature?: string;
  contextLength?: number;
}

export type ResolveTextHighlightAnchorResult =
  | {
      status: 'resolved';
      start: number;
      end: number;
      exact: string;
      relocated: boolean;
    }
  | {
      status: 'detached';
      reason: 'content_modified';
      exact: string;
    }
  | {
      status: 'ambiguous';
      candidates: Array<{ start: number; end: number }>;
      exact: string;
    }
  | {
      status: 'not_found';
      exact: string;
    };

const DEFAULT_CONTEXT_LENGTH = 32;

/**
 * 计算正文内容稳定签名（FNV-1a 32-bit）：
 * 正文被编辑后签名变化，旧高亮摘录仅保留查看而不错误覆盖到新正文上。
 */
export function computeContentSignature(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(36)}`;
}

/**
 * 根据全文、起止偏移及材料元数据构造双锚点（TextPositionSelector + TextQuoteSelector）。
 */
export function createTextHighlightAnchor(
  fullText: string,
  start: number,
  end: number,
  meta: CreateTextHighlightAnchorMeta
): MaterialTextAnchor {
  const safeLen = fullText.length;
  const rawStart = Math.max(0, Math.min(safeLen, Math.trunc(start)));
  const rawEnd = Math.max(0, Math.min(safeLen, Math.trunc(end)));
  const normalizedStart = Math.min(rawStart, rawEnd);
  const normalizedEnd = Math.max(rawStart, rawEnd);
  const contextLen = Math.max(1, meta.contextLength ?? DEFAULT_CONTEXT_LENGTH);

  const exact = fullText.slice(normalizedStart, normalizedEnd);
  const prefix = fullText.slice(Math.max(0, normalizedStart - contextLen), normalizedStart);
  const suffix = fullText.slice(normalizedEnd, Math.min(safeLen, normalizedEnd + contextLen));
  const contentSignature = meta.contentSignature ?? computeContentSignature(fullText);

  return {
    format: meta.format,
    pageOrSegment: meta.pageOrSegment,
    start: normalizedStart,
    end: normalizedEnd,
    exact,
    prefix,
    suffix,
    contentSignature,
  };
}

/**
 * 解析双锚点在当前正文中的精确字符区间：
 * 1. 若 currentSignature !== anchor.contentSignature，返回 { status: 'detached', reason: 'content_modified' }；
 * 2. 若 [start, end] 直接匹配 exact，立即返回命中；
 * 3. 若偏移变化，在全文查找 exact：唯一命中则采用；多处命中则用 prefix + suffix 消歧；
 * 4. 若仍无法唯一确定，返回 { status: 'ambiguous' }（绝不盲猜位置）。
 */
export function resolveTextHighlightAnchor(
  fullText: string,
  anchor: MaterialTextAnchor,
  currentSignature?: string
): ResolveTextHighlightAnchorResult {
  const effectiveSignature = currentSignature ?? computeContentSignature(fullText);
  if (effectiveSignature !== anchor.contentSignature) {
    return {
      status: 'detached',
      reason: 'content_modified',
      exact: anchor.exact,
    };
  }

  if (!anchor.exact || anchor.exact.length === 0) {
    return {
      status: 'not_found',
      exact: '',
    };
  }

  // 1. TextPositionSelector 直接命中
  if (
    anchor.start >= 0 &&
    anchor.end <= fullText.length &&
    anchor.end - anchor.start === anchor.exact.length &&
    fullText.slice(anchor.start, anchor.end) === anchor.exact
  ) {
    return {
      status: 'resolved',
      start: anchor.start,
      end: anchor.end,
      exact: anchor.exact,
      relocated: false,
    };
  }

  // 2. TextQuoteSelector 全文检索
  const candidates: Array<{ start: number; end: number }> = [];
  let searchFrom = 0;
  while (searchFrom <= fullText.length - anchor.exact.length) {
    const idx = fullText.indexOf(anchor.exact, searchFrom);
    if (idx === -1) break;
    candidates.push({ start: idx, end: idx + anchor.exact.length });
    searchFrom = idx + 1;
  }

  if (candidates.length === 0) {
    return {
      status: 'not_found',
      exact: anchor.exact,
    };
  }

  if (candidates.length === 1) {
    return {
      status: 'resolved',
      start: candidates[0].start,
      end: candidates[0].end,
      exact: anchor.exact,
      relocated: true,
    };
  }

  // 3. 多处命中时使用 prefix + suffix 消歧（绝不按距离猜测）
  const matchesPrefix = (candStart: number): boolean => {
    if (!anchor.prefix) return true;
    const actualPrefix = fullText.slice(
      Math.max(0, candStart - anchor.prefix.length),
      candStart
    );
    return actualPrefix === anchor.prefix;
  };

  const matchesSuffix = (candEnd: number): boolean => {
    if (!anchor.suffix) return true;
    const actualSuffix = fullText.slice(candEnd, candEnd + anchor.suffix.length);
    return actualSuffix === anchor.suffix;
  };

  if (anchor.prefix || anchor.suffix) {
    const bothMatched = candidates.filter(
      (c) => matchesPrefix(c.start) && matchesSuffix(c.end)
    );
    if (bothMatched.length === 1) {
      return {
        status: 'resolved',
        start: bothMatched[0].start,
        end: bothMatched[0].end,
        exact: anchor.exact,
        relocated: true,
      };
    }
    if (bothMatched.length > 1) {
      return {
        status: 'ambiguous',
        candidates: bothMatched,
        exact: anchor.exact,
      };
    }

    // 若一侧上下文因排版空白调整未完全匹配，但另一侧非空且唯一匹配，则采用该唯一匹配
    const prefixOnlyMatched = anchor.prefix
      ? candidates.filter((c) => matchesPrefix(c.start))
      : [];
    const suffixOnlyMatched = anchor.suffix
      ? candidates.filter((c) => matchesSuffix(c.end))
      : [];

    if (prefixOnlyMatched.length === 1 && suffixOnlyMatched.length === 0) {
      return {
        status: 'resolved',
        start: prefixOnlyMatched[0].start,
        end: prefixOnlyMatched[0].end,
        exact: anchor.exact,
        relocated: true,
      };
    }
    if (suffixOnlyMatched.length === 1 && prefixOnlyMatched.length === 0) {
      return {
        status: 'resolved',
        start: suffixOnlyMatched[0].start,
        end: suffixOnlyMatched[0].end,
        exact: anchor.exact,
        relocated: true,
      };
    }
  }

  return {
    status: 'ambiguous',
    candidates,
    exact: anchor.exact,
  };
}

// ============================================================================
// 智能批注与掌触拒绝（Palm Rejection）指针仲裁器
// ============================================================================

export type AnnotationPointerAction = 'draw' | 'scroll' | 'select' | 'ignore-palm';

export interface AnnotationPointerEventLike {
  pointerId: number;
  pointerType: 'pen' | 'touch' | 'mouse' | string;
  type?: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel' | string;
  width?: number;
  height?: number;
  isPalm?: boolean;
}

export interface AnnotationPointerArbitrationConfig {
  /** 是否开启智能批注（主动触控笔书写、手指拖动阅读、鼠标拖选文字） */
  smartAnnotation?: boolean;
  /** 非智能批注模式下的当前工具 */
  activeTool?: 'pen' | 'highlight' | 'text-highlight' | 'pan' | 'select';
  /** 材料格式（Markdown 默认选字，其余默认滚动/拖动） */
  format?: MaterialFormat;
  /** 是否允许手指绘制（电容笔模式） */
  allowTouchDraw?: boolean;
  /** 当前是否有主动触控笔正在书写（落笔期间新的触摸记为掌触） */
  activePenStroke?: boolean;
  /** 已被识别为手掌误触的 pointerId 集合（必须 pointerup/pointercancel 离屏后才移除） */
  palmRejectedPointerIds?: Set<number>;
  /** 判定接触面积为手掌误触的尺寸阈值（默认 28） */
  palmContactSizeThreshold?: number;
}

const DEFAULT_PALM_CONTACT_THRESHOLD = 28;
const sharedPalmRejectedPointerIds = new Set<number>();

export function resetSharedPalmRejectedPointers(): void {
  sharedPalmRejectedPointerIds.clear();
}

/**
 * 仲裁阅读材料批注指针事件：
 * - 已被标记为掌触（palm）的 pointerId 必须在 pointerup / pointercancel 离屏后才从黑名单移除；
 * - 智能批注开启时：pen -> 'draw'，touch -> 'scroll'（除非开启 allowTouchDraw），mouse -> 'select'。
 */
export function arbitrateAnnotationPointerInput(
  event: AnnotationPointerEventLike,
  config: AnnotationPointerArbitrationConfig = {}
): AnnotationPointerAction {
  const palmSet = config.palmRejectedPointerIds ?? sharedPalmRejectedPointerIds;
  const threshold = config.palmContactSizeThreshold ?? DEFAULT_PALM_CONTACT_THRESHOLD;
  const eventType = event.type ?? 'pointerdown';
  const isReleaseEvent = eventType === 'pointerup' || eventType === 'pointercancel';

  if (event.pointerType === 'touch') {
    const exceedsPalmSize =
      (typeof event.width === 'number' && event.width >= threshold) ||
      (typeof event.height === 'number' && event.height >= threshold);
    const isNewPalmContact =
      event.isPalm === true || Boolean(config.activePenStroke) || exceedsPalmSize;

    if (palmSet.has(event.pointerId)) {
      if (isReleaseEvent) {
        palmSet.delete(event.pointerId);
      }
      return 'ignore-palm';
    }

    if (isNewPalmContact) {
      if (!isReleaseEvent) {
        palmSet.add(event.pointerId);
      }
      return 'ignore-palm';
    }
  } else if (isReleaseEvent && palmSet.has(event.pointerId)) {
    palmSet.delete(event.pointerId);
  }

  const smartAnnotation = config.smartAnnotation ?? true;

  if (smartAnnotation) {
    if (event.pointerType === 'pen') {
      return 'draw';
    }
    if (event.pointerType === 'touch') {
      return config.allowTouchDraw ? 'draw' : 'scroll';
    }
    if (event.pointerType === 'mouse') {
      if (config.activeTool === 'pen' || config.activeTool === 'highlight') {
        return 'draw';
      }
      if (config.activeTool === 'pan') {
        return 'scroll';
      }
      return 'select';
    }
  }

  // 非智能批注模式：按显式工具或材料默认行为仲裁
  if (config.activeTool === 'pen' || config.activeTool === 'highlight') {
    if (event.pointerType === 'touch') {
      return config.allowTouchDraw ? 'draw' : 'scroll';
    }
    return 'draw';
  }

  if (config.activeTool === 'text-highlight' || config.activeTool === 'select') {
    return 'select';
  }

  if (config.activeTool === 'pan') {
    return 'scroll';
  }

  if (config.format === 'markdown' && event.pointerType !== 'touch') {
    return 'select';
  }

  return 'scroll';
}

// ============================================================================
// 引用提问格式化（转义 HTML 特殊字符并包装为带来源页/段的 <mark>...</mark>）
// ============================================================================

export function escapeHighlightHtmlText(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function formatHighlightCitationForPrompt(
  anchor: Pick<MaterialTextAnchor, 'format' | 'pageOrSegment' | 'exact'>,
  options?: { materialTitle?: string }
): string {
  const unitName = anchor.format === 'pdf' ? '页' : '段';
  const locationLabel = `第 ${anchor.pageOrSegment} ${unitName}`;
  const sourcePrefix = options?.materialTitle?.trim()
    ? `[${options.materialTitle.trim()} · ${locationLabel}]`
    : `[${locationLabel}]`;
  const escapedExact = escapeHighlightHtmlText(anchor.exact);
  return `${sourcePrefix} <mark>${escapedExact}</mark>`;
}
