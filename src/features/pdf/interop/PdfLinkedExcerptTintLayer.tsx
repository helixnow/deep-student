/**
 * PDF 正文持久联动微染层（C7 §2.1 Persistent Linked Excerpt Tint Layer）。
 *
 * - 订阅当前 PDF 资源（`resourceId` 及可选别名）的 `AnchorEdge[]`，筛选落在当前可见页且携带归一化
 *   `rectNorm`（`[0, 1]`）的引用边，渲染低饱和度 Mineral 分支语义微染底色（亮色 `0.14` / 暗色 `0.18`）。
 * - 顺滑度铁律：外层容器与微染矩形严格保持 `pointer-events: none`，绝不阻断下方原生 `.textLayer` 划词选区；
 *   仅在每个摘录矩形角部挂载一枚紧凑微胶囊（`pointer-events: auto`、`nodrag`、`6px` 分支色圆点），
 *   悬停展示下游导图节点 / 闪卡标题，点击通过 `anchors.reveal` 反向跳转定位。
 * - 当下游导图删除引用边或修改 `branchColor` 时，微染层实时响应更新或消退。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  fnv1a64Hex,
  parseSemanticAnchor,
  sanitizeNormalizedRect,
  type AnchorEdgeRecord,
  type AnchorEdgeSourceKind,
  type NormalizedRect,
  type SemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { cn } from '@/utils/cn';
import { rotateNormalizedRect } from './pdfInteropBridge';

// ============================================================================
// Mineral 分支语义微染色板与类型定义
// ============================================================================

export type MineralBranchColorToken = 'celadon' | 'amber' | 'indigo' | 'rose' | 'slate';

export const MINERAL_BRANCH_COLOR_TOKENS: readonly MineralBranchColorToken[] = [
  'celadon',
  'amber',
  'indigo',
  'rose',
  'slate',
] as const;

export const MINERAL_TINT_OPACITY_LIGHT = 0.14;
export const MINERAL_TINT_OPACITY_DARK = 0.18;

/** Mineral 低饱和矿物分支色板（与 MindMap Mineral 主题色阶对齐） */
export const MINERAL_TINT_PALETTE: Record<
  MineralBranchColorToken,
  { readonly light: string; readonly dark: string }
> = {
  celadon: { light: '#2A6F5E', dark: '#5EA893' },
  amber: { light: '#A6893E', dark: '#C9B168' },
  indigo: { light: '#4B5E8A', dark: '#7E95C4' },
  rose: { light: '#A85D74', dark: '#C9879C' },
  slate: { light: '#566873', dark: '#8BA0AD' },
};

const TOKEN_ALIASES: Record<string, MineralBranchColorToken> = {
  celadon: 'celadon',
  green: 'celadon',
  teal: 'celadon',
  sage: 'celadon',
  amber: 'amber',
  ochre: 'amber',
  yellow: 'amber',
  gold: 'amber',
  orange: 'amber',
  indigo: 'indigo',
  blue: 'indigo',
  purple: 'indigo',
  violet: 'indigo',
  amethyst: 'indigo',
  porcelain: 'indigo',
  rose: 'rose',
  pink: 'rose',
  red: 'rose',
  terracotta: 'rose',
  crimson: 'rose',
  plum: 'rose',
  slate: 'slate',
  stone: 'slate',
  gray: 'slate',
  grey: 'slate',
  neutral: 'slate',
};

/** 已知 MindMap 矿物色板十六进制值到 Mineral 语义令牌的确定性映射 */
const KNOWN_MINERAL_HEX_TO_TOKEN: Record<string, MineralBranchColorToken> = {
  // Celadon / 松绿
  '#2a6f5e': 'celadon',
  '#5ea893': 'celadon',
  '#3e755b': 'celadon',
  '#6da68a': 'celadon',
  '#4a7859': 'celadon',
  '#7eb08e': 'celadon',
  // Amber / 琥珀 / 赭石
  '#a6893e': 'amber',
  '#c9b168': 'amber',
  '#c27d48': 'amber',
  '#d99e6c': 'amber',
  '#9e8238': 'amber',
  '#c4ad6a': 'amber',
  '#b87343': 'amber',
  '#d49a70': 'amber',
  '#a88a40': 'amber',
  '#ccb36a': 'amber',
  '#c47e4a': 'amber',
  '#dba06e': 'amber',
  '#9e8036': 'amber',
  '#c7b26b': 'amber',
  '#b8763c': 'amber',
  '#d6a16e': 'amber',
  // Indigo / 黛蓝 / 藤紫
  '#4b5e8a': 'indigo',
  '#7e95c4': 'indigo',
  '#3b6e8c': 'indigo',
  '#6b9ebd': 'indigo',
  '#6a5d8e': 'indigo',
  '#9689ba': 'indigo',
  '#38688a': 'indigo',
  '#6a9ab8': 'indigo',
  '#635688': 'indigo',
  '#9185b5': 'indigo',
  '#3a6f8f': 'indigo',
  '#6ca0bf': 'indigo',
  '#6c5e91': 'indigo',
  '#988bbc': 'indigo',
  '#3d6985': 'indigo',
  '#7aa2bd': 'indigo',
  '#6b5b8e': 'indigo',
  '#9e90c2': 'indigo',
  // Rose / 梅粉 / 赤陶
  '#a85d74': 'rose',
  '#c9879c': 'rose',
  '#b55a52': 'rose',
  '#d4857d': 'rose',
  '#a8524d': 'rose',
  '#cc8580': 'rose',
  '#9e546b': 'rose',
  '#c28298': 'rose',
  '#b85d56': 'rose',
  '#d68880': 'rose',
  '#aa5e76': 'rose',
  '#cb899e': 'rose',
  '#ad4e46': 'rose',
  '#d4877c': 'rose',
  '#9e5870': 'rose',
  '#c28a9e': 'rose',
  // Slate / 冷灰石韵
  '#566873': 'slate',
  '#8ba0ad': 'slate',
};

const SAFE_CSS_COLOR_RE =
  /^(?:#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.\s,%/]+\)|hsla?\(\s*[\d.\s,deg%/]+\))$/;

const BRANCH_COLOR_PARAM_KEYS = [
  'branchColorToken',
  'branchColor',
  'p.branchColorToken',
  'p.branchColor',
  'color',
  'p.color',
] as const;

export type PdfTintEdgeInput = AnchorEdgeRecord & {
  /** 可选归一化矩形别名（与 targetRect 同义） */
  rectNorm?: NormalizedRect | null;
  /** 可选直接携带的分支色令牌或 CSS 色值 */
  branchColor?: string | null;
  branchColorToken?: string | null;
  /** 可选内存态上游锚点对象（携带 branchColor 元数据） */
  sourceAnchor?: SemanticAnchor & {
    branchColor?: string;
    branchColorToken?: string;
    metadata?: Record<string, unknown>;
    params?: Readonly<Record<string, string>>;
  };
  /** 可选附加元数据对象或 JSON 字符串 */
  metadata?: Record<string, unknown> | string | null;
};

export interface ResolvedBranchTintColor {
  token: MineralBranchColorToken;
  cssColor: string;
  isExplicit: boolean;
}

export interface ResolvedPdfExcerptTintItem {
  edge: PdfTintEdgeInput;
  page: number;
  rectNorm: NormalizedRect;
  token: MineralBranchColorToken;
  cssColor: string;
  title: string;
  cornerOffsetPx: number;
}

export interface PdfLinkedExcerptTintLayerProps {
  /** 当前激活 PDF 资源 ID（传入 edges 时可省略） */
  resourceId?: string;
  /** 附加匹配资源 ID（如 VFS resourceId、resourcePath） */
  aliasResourceIds?: readonly string[];
  /** 1-based 可见页码 */
  page: number;
  /** 当前页面顺时针旋转角度；锚点始终保存未旋转坐标。 */
  rotation?: number;
  /** 暗色阅读 / 深色主题标记；缺省时自动监听根文档深浅色切换 */
  isDark?: boolean;
  /** 可选外部已订阅的 AnchorEdge 列表；缺省时组件自动订阅 kernel.anchors */
  edges?: readonly PdfTintEdgeInput[];
  className?: string;
}

// ============================================================================
// 纯函数：分支色解析、归一化几何过滤与页内聚合
// ============================================================================

function pickFirstString(record: Record<string, unknown> | undefined | null, keys: readonly string[]): string | null {
  if (!record || typeof record !== 'object') return null;
  for (const key of keys) {
    const val = record[key];
    if (typeof val === 'string' && val.trim()) {
      return val.trim();
    }
  }
  return null;
}

function extractColorFromAnchorUri(uri: string | undefined): string | null {
  if (typeof uri !== 'string' || !uri) return null;
  const qIndex = uri.indexOf('?');
  if (qIndex < 0) return null;
  const rawQuery = uri.slice(qIndex + 1);
  try {
    const params = new URLSearchParams(rawQuery);
    for (const key of BRANCH_COLOR_PARAM_KEYS) {
      const val = params.get(key);
      if (val && val.trim()) return val.trim();
    }
  } catch {
    // 忽略异常 URI 查询串
  }
  return null;
}

function extractRawEdgeBranchColor(edge: PdfTintEdgeInput): string | null {
  if (typeof edge.branchColorToken === 'string' && edge.branchColorToken.trim()) {
    return edge.branchColorToken.trim();
  }
  if (typeof edge.branchColor === 'string' && edge.branchColor.trim()) {
    return edge.branchColor.trim();
  }

  if (edge.metadata) {
    let metaObj: Record<string, unknown> | null = null;
    if (typeof edge.metadata === 'object' && !Array.isArray(edge.metadata)) {
      metaObj = edge.metadata;
    } else if (typeof edge.metadata === 'string' && edge.metadata.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(edge.metadata);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metaObj = parsed as Record<string, unknown>;
        }
      } catch {
        metaObj = null;
      }
    }
    const fromMeta = pickFirstString(metaObj, ['branchColorToken', 'branchColor', 'color']);
    if (fromMeta) return fromMeta;
  }

  if (edge.sourceAnchor && typeof edge.sourceAnchor === 'object') {
    const src = edge.sourceAnchor as unknown as Record<string, unknown>;
    const direct = pickFirstString(src, ['branchColorToken', 'branchColor', 'color']);
    if (direct) return direct;
    const fromSrcMeta = pickFirstString(src.metadata as Record<string, unknown> | undefined, [
      'branchColorToken',
      'branchColor',
      'color',
    ]);
    if (fromSrcMeta) return fromSrcMeta;
    const fromSrcParams = pickFirstString(src.params as Record<string, unknown> | undefined, [
      'branchColorToken',
      'branchColor',
      'color',
    ]);
    if (fromSrcParams) return fromSrcParams;
  }

  if (edge.sourceAnchorUri) {
    const parsedSource = parseSemanticAnchor(edge.sourceAnchorUri);
    if (parsedSource?.kind === 'custom' && parsedSource.params) {
      const fromCustomParams = pickFirstString(parsedSource.params, [
        'branchColorToken',
        'branchColor',
        'color',
      ]);
      if (fromCustomParams) return fromCustomParams;
    }
    const fromSourceQuery = extractColorFromAnchorUri(edge.sourceAnchorUri);
    if (fromSourceQuery) return fromSourceQuery;
  }

  return extractColorFromAnchorUri(edge.targetAnchorUri);
}

function fallbackTokenForEdge(edge: PdfTintEdgeInput): MineralBranchColorToken {
  const seed = `${edge.sourceKind}:${edge.sourceResourceId}:${edge.sourceSubId || edge.sourceAnchorUri || edge.edgeId}`;
  const hashHex = fnv1a64Hex(seed);
  const bucket = Number.parseInt(hashHex.slice(0, 8), 16) % MINERAL_BRANCH_COLOR_TOKENS.length;
  return MINERAL_BRANCH_COLOR_TOKENS[bucket] ?? 'celadon';
}

/**
 * 解析引用边的分支微染颜色：
 * 1. 优先读取 `sourceAnchor` 元数据或边上的 `branchColor` / `branchColorToken`；
 * 2. 缺失时按上游节点身份确定性哈希回退至 Mineral 五色色板（celadon / amber / indigo / rose / slate）。
 */
export function resolveEdgeBranchColor(
  edge: PdfTintEdgeInput,
  isDark = false,
): ResolvedBranchTintColor {
  const raw = extractRawEdgeBranchColor(edge);
  if (raw) {
    const lower = raw.toLowerCase();
    const byName = TOKEN_ALIASES[lower];
    if (byName) {
      return {
        token: byName,
        cssColor: isDark ? MINERAL_TINT_PALETTE[byName].dark : MINERAL_TINT_PALETTE[byName].light,
        isExplicit: true,
      };
    }
    const byHex = KNOWN_MINERAL_HEX_TO_TOKEN[lower];
    if (byHex) {
      return {
        token: byHex,
        cssColor: isDark ? MINERAL_TINT_PALETTE[byHex].dark : MINERAL_TINT_PALETTE[byHex].light,
        isExplicit: true,
      };
    }
    if (SAFE_CSS_COLOR_RE.test(raw)) {
      return {
        token: fallbackTokenForEdge(edge),
        cssColor: raw,
        isExplicit: true,
      };
    }
  }

  const token = fallbackTokenForEdge(edge);
  return {
    token,
    cssColor: isDark ? MINERAL_TINT_PALETTE[token].dark : MINERAL_TINT_PALETTE[token].light,
    isExplicit: false,
  };
}

export function resolveEdgeNormalizedRect(edge: PdfTintEdgeInput): NormalizedRect | null {
  const fromTarget = sanitizeNormalizedRect(edge.targetRect);
  if (fromTarget) return fromTarget;
  const fromAlias = sanitizeNormalizedRect(edge.rectNorm);
  if (fromAlias) return fromAlias;
  if (typeof edge.targetAnchorUri === 'string' && edge.targetAnchorUri) {
    const parsed = parseSemanticAnchor(edge.targetAnchorUri);
    if (parsed?.kind === 'pdf' && parsed.rect) {
      return sanitizeNormalizedRect(parsed.rect);
    }
  }
  return null;
}

export function resolveEdgeTargetPage(edge: PdfTintEdgeInput): number | null {
  if (typeof edge.targetPage === 'number' && Number.isInteger(edge.targetPage) && edge.targetPage >= 1) {
    return edge.targetPage;
  }
  if (typeof edge.targetAnchorUri === 'string' && edge.targetAnchorUri) {
    const parsed = parseSemanticAnchor(edge.targetAnchorUri);
    if (parsed?.kind === 'pdf') return parsed.page;
  }
  return null;
}

function edgeMatchesResourceSet(edge: PdfTintEdgeInput, idSet: ReadonlySet<string>): boolean {
  if (idSet.size === 0) return true;
  if (typeof edge.targetResourceId === 'string' && idSet.has(edge.targetResourceId.trim())) {
    return true;
  }
  if (typeof edge.targetAnchorUri === 'string' && edge.targetAnchorUri) {
    const parsed = parseSemanticAnchor(edge.targetAnchorUri);
    if (parsed) {
      if (idSet.has(parsed.resourceId)) return true;
      if (parsed.aliasResourceId && idSet.has(parsed.aliasResourceId)) return true;
    }
  }
  return false;
}

export function selectPageExcerptTintItems(
  edges: readonly PdfTintEdgeInput[],
  options: {
    page: number;
    rotation?: number;
    resourceIds?: readonly string[];
    isDark?: boolean;
    fallbackTitleByKind?: Partial<Record<AnchorEdgeSourceKind, string>>;
  },
): ResolvedPdfExcerptTintItem[] {
  if (!Number.isInteger(options.page) || options.page < 1 || edges.length === 0) {
    return [];
  }

  const idSet = new Set(
    (options.resourceIds ?? [])
      .filter((id): id is string => typeof id === 'string')
      .map((id) => id.trim())
      .filter(Boolean),
  );

  // 同一 edgeId 以最新记录为准，保证属性更新时原地生效
  const dedupedById = new Map<string, PdfTintEdgeInput>();
  for (const edge of edges) {
    if (!edge || !edge.edgeId) continue;
    if (edge.targetKind && edge.targetKind !== 'pdf') continue;
    if (!edgeMatchesResourceSet(edge, idSet)) continue;
    const targetPage = resolveEdgeTargetPage(edge);
    if (targetPage !== options.page) continue;
    dedupedById.set(edge.edgeId, edge);
  }

  const cornerSlots: Array<{ rightX: number; topY: number; count: number }> = [];
  const items: ResolvedPdfExcerptTintItem[] = [];

  for (const edge of dedupedById.values()) {
    const storedRect = resolveEdgeNormalizedRect(edge);
    const rectNorm = storedRect && (options.rotation ? rotateNormalizedRect(storedRect, options.rotation) : storedRect);
    if (!rectNorm) continue;

    const color = resolveEdgeBranchColor(edge, Boolean(options.isDark));
    const parsedSource = edge.sourceAnchorUri ? parseSemanticAnchor(edge.sourceAnchorUri) : null;
    const title =
      edge.sourceLabel?.trim() ||
      edge.sourceAnchor?.label?.trim() ||
      parsedSource?.label?.trim() ||
      options.fallbackTitleByKind?.[edge.sourceKind] ||
      edge.sourceResourceId;

    const rightX = rectNorm.x + rectNorm.w;
    const topY = rectNorm.y;
    let slot = cornerSlots.find(
      (candidate) => Math.abs(candidate.rightX - rightX) < 0.012 && Math.abs(candidate.topY - topY) < 0.015,
    );
    if (!slot) {
      slot = { rightX, topY, count: 0 };
      cornerSlots.push(slot);
    }
    const cornerOffsetPx = slot.count * 18;
    slot.count += 1;

    items.push({
      edge,
      page: options.page,
      rectNorm,
      token: color.token,
      cssColor: color.cssColor,
      title,
      cornerOffsetPx,
    });
  }

  return items;
}

// ============================================================================
// Hook：订阅当前 PDF 资源的 AnchorEdge[]（外部未传入 edges 时启用）
// ============================================================================

export function usePdfResourceAnchorEdges(
  resourceIds: readonly string[],
  externalEdges?: readonly PdfTintEdgeInput[],
): readonly PdfTintEdgeInput[] {
  const [subscribedEdges, setSubscribedEdges] = useState<AnchorEdgeRecord[]>([]);
  const resourceKey = JSON.stringify(resourceIds);

  useEffect(() => {
    if (externalEdges !== undefined) return;
    setSubscribedEdges([]);
    if (resourceIds.length === 0) return;

    const kernel = getAppKernel();
    const ids = [...resourceIds];
    const idSet = new Set(ids);
    let disposed = false;
    let querySeq = 0;

    const load = () => {
      const seq = ++querySeq;
      void kernel.anchors
        .queryAnchorEdgesByTarget({ targetResourceIds: ids, targetKind: 'pdf' })
        .then((nextEdges) => {
          if (!disposed && seq === querySeq) {
            setSubscribedEdges(nextEdges);
          }
        })
        .catch(() => {
          // 微染层属于增强投影：查询异常不打断正文阅读
        });
    };

    load();
    const unsubscribe = kernel.anchors.subscribeAnchorEdgesChanged((detail) => {
      if (
        detail.targetResourceIds.length === 0 ||
        detail.targetResourceIds.some((id) => idSet.has(id))
      ) {
        load();
      }
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resourceKey 是 resourceIds 的稳定摘要
  }, [externalEdges !== undefined, resourceKey]);

  return externalEdges ?? subscribedEdges;
}

function detectDocumentDarkTheme(): boolean {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return root.classList.contains('dark') || root.dataset.theme === 'dark';
}

const stopPointerEvent = (event: React.SyntheticEvent) => {
  event.stopPropagation();
};

// ============================================================================
// 组件实现
// ============================================================================

export const PdfLinkedExcerptTintLayer: React.FC<PdfLinkedExcerptTintLayerProps> = ({
  resourceId,
  aliasResourceIds,
  page,
  rotation = 0,
  isDark,
  edges: externalEdges,
  className,
}) => {
  const { t } = useTranslation('pdf');
  const [ambientDark, setAmbientDark] = useState<boolean>(() => detectDocumentDarkTheme());
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);

  useEffect(() => {
    if (isDark !== undefined || typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
      return;
    }
    const root = document.documentElement;
    const sync = () => setAmbientDark(detectDocumentDarkTheme());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [isDark]);

  const resolvedIsDark = isDark ?? ambientDark;

  const resourceIds = useMemo(() => {
    const raw = [resourceId, ...(aliasResourceIds ?? [])]
      .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    return Array.from(new Set(raw));
  }, [resourceId, aliasResourceIds]);

  const allEdges = usePdfResourceAnchorEdges(resourceIds, externalEdges);

  const fallbackTitleByKind = useMemo<Partial<Record<AnchorEdgeSourceKind, string>>>(
    () => ({
      mindmap: t('pdf:interop.tint_source_mindmap'),
      flashcard: t('pdf:interop.tint_source_flashcard'),
      note: t('pdf:interop.tint_source_note'),
      qbank: t('pdf:interop.tint_source_qbank'),
    }),
    [t],
  );

  const items = useMemo(
    () =>
      selectPageExcerptTintItems(allEdges, {
        page,
        rotation,
        resourceIds,
        isDark: resolvedIsDark,
        fallbackTitleByKind,
      }),
    [allEdges, page, rotation, resourceIds, resolvedIsDark, fallbackTitleByKind],
  );

  const handleRevealSource = useCallback((edge: PdfTintEdgeInput) => {
    const target = edge.sourceAnchorUri || edge.sourceAnchor;
    if (!target) return;
    void getAppKernel().anchors.reveal(target, { splitIfClosed: true, pulse: true });
  }, []);

  if (items.length === 0) return null;

  const tintOpacity = resolvedIsDark ? MINERAL_TINT_OPACITY_DARK : MINERAL_TINT_OPACITY_LIGHT;

  return (
    <div
      className={cn('ds-pdf__excerpt-tint-layer', className)}
      data-testid="pdf-linked-excerpt-tint-layer"
      data-page={page}
      data-dark={resolvedIsDark ? 'true' : 'false'}
      style={{ pointerEvents: 'none' }}
    >
      {items.map((item) => {
        const isHovered = hoveredEdgeId === item.edge.edgeId;
        const pillTopPx = item.rectNorm.y < 0.025 ? 2 : -7;
        const tooltipAlignLeft = item.rectNorm.x + item.rectNorm.w < 0.35;

        return (
          <div
            key={item.edge.edgeId}
            className="ds-pdf__excerpt-tint-item"
            data-testid="pdf-linked-excerpt-tint-item"
            data-edge-id={item.edge.edgeId}
            data-branch-token={item.token}
            style={{
              left: `${item.rectNorm.x * 100}%`,
              top: `${item.rectNorm.y * 100}%`,
              width: `${item.rectNorm.w * 100}%`,
              height: `${item.rectNorm.h * 100}%`,
              pointerEvents: 'none',
            }}
          >
            <div
              className={cn(
                'ds-pdf__excerpt-tint-rect',
                isHovered && 'ds-pdf__excerpt-tint-rect--hovered',
              )}
              data-testid="pdf-linked-excerpt-tint-rect"
              aria-hidden="true"
              style={{
                backgroundColor: item.cssColor,
                opacity: tintOpacity,
                pointerEvents: 'none',
              }}
            />

            <button
              type="button"
              className="ds-pdf__excerpt-tint-pill nodrag nopan"
              data-testid="pdf-linked-excerpt-tint-pill"
              data-edge-id={item.edge.edgeId}
              style={{
                pointerEvents: 'auto',
                top: `${pillTopPx}px`,
                right: `${item.cornerOffsetPx}px`,
              }}
              title={item.title}
              aria-label={t('pdf:interop.tint_jump_to_source', { title: item.title })}
              onPointerDown={stopPointerEvent}
              onMouseDown={stopPointerEvent}
              onMouseUp={stopPointerEvent}
              onDoubleClick={stopPointerEvent}
              onMouseEnter={() => setHoveredEdgeId(item.edge.edgeId)}
              onMouseLeave={() =>
                setHoveredEdgeId((prev) => (prev === item.edge.edgeId ? null : prev))
              }
              onFocus={() => setHoveredEdgeId(item.edge.edgeId)}
              onBlur={() =>
                setHoveredEdgeId((prev) => (prev === item.edge.edgeId ? null : prev))
              }
              onClick={(event) => {
                event.stopPropagation();
                handleRevealSource(item.edge);
              }}
            >
              <span
                className="ds-pdf__excerpt-tint-dot h-1.5 w-1.5 shrink-0 rounded-full"
                data-testid="pdf-linked-excerpt-tint-dot"
                style={{ backgroundColor: item.cssColor }}
                aria-hidden="true"
              />
            </button>

            {isHovered && (
              <div
                role="tooltip"
                data-testid="pdf-linked-excerpt-tint-tooltip"
                className={cn(
                  'ds-pdf__excerpt-tint-tooltip pointer-events-none absolute z-[6] max-w-[200px] truncate rounded-md border border-border/35 bg-card/95 px-2 py-0.5 text-[11px] text-foreground shadow-sm backdrop-blur-sm',
                  tooltipAlignLeft ? 'left-0' : 'right-0',
                )}
                style={{
                  pointerEvents: 'none',
                  top: item.rectNorm.y < 0.06 ? '14px' : '-26px',
                }}
              >
                {item.title}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default PdfLinkedExcerptTintLayer;
