/**
 * 流式标记解析器 - 支持增量解析不完整的标记符
 * 
 * 核心思路：
 * 1. 维护一个"已确认完成"的片段列表
 * 2. 维护一个"待处理"缓冲区（可能包含不完整的标记）
 * 3. 每次新数据到达时，尝试从缓冲区中解析出完整的标记
 */

import type { GradeCode } from './types';
import type { ErrorType } from './markerTypes';

export type MarkerType = 'del' | 'ins' | 'replace' | 'note' | 'good' | 'err' | 'text' | 'pending';

export interface StreamingMarker {
  type: MarkerType;
  content: string;
  // del
  reason?: string;
  // replace
  oldText?: string;
  newText?: string;
  // note
  comment?: string;
  // err（词汇表见 markerTypes.ErrorType，与后端 MARKER_INSTRUCTIONS 一致）
  errorType?: ErrorType;
  explanation?: string;
  // 标记是否完整
  isComplete: boolean;
}

/**
 * 评分解析结果（类型真相源）。
 * markerParser 的 ParsedScore 从这里 re-export，ScoreCard 等消费方应从本模块导入。
 */
export interface ParsedScore {
  total: number;
  maxTotal: number;
  /** 等级代码，使用 essay_grading:score.grade.{code} 获取本地化文案 */
  grade: GradeCode;
  dimensions: DimensionScore[];
  isComplete: boolean;
}

export interface DimensionScore {
  name: string;
  score: number;
  maxScore: number;
  comment?: string;
}

/** 润色提升项 */
export interface PolishItem {
  original: string;
  polished: string;
}

/**
 * 宽松提取属性值：
 * 允许属性值内部出现同种引号字符（例如：text="包含 "引号" 的内容"）。
 * 结束引号判定：后续是空白+下一个属性，或字符串结束。
 */
function extractAttributeValue(attrs: string, attrName: string): string | undefined {
  // (?:^|\s) 边界防止匹配到其他属性名的后缀（如 old 误匹配 bold）
  const attrStartRegex = new RegExp(`(?:^|\\s)${attrName}\\s*=\\s*(['"])`, 'i');
  const startMatch = attrStartRegex.exec(attrs);
  if (!startMatch || startMatch.index == null) return undefined;

  const quoteChar = startMatch[1];
  const valueStart = startMatch.index + startMatch[0].length;

  for (let i = valueStart; i < attrs.length; i += 1) {
    if (attrs[i] !== quoteChar) continue;
    const tail = attrs.slice(i + 1);
    if (/^\s*$/.test(tail) || /^\s+[A-Za-z_][\w:.-]*\s*=/.test(tail)) {
      return attrs.slice(valueStart, i);
    }
  }

  return attrs.slice(valueStart).trim() || undefined;
}

/**
 * 剥离嵌套在标记内容中的其他标记标签（保留内层文本）。
 * LLM 违反"标记不嵌套"约定时，避免原始 XML 标签泄漏到 UI/导出文本。
 */
const NESTED_MARKER_TAG_REGEX = /<\/?(?:del|ins|note|good|err)\b[^>]*>|<replace\b[^>]*\/?>/gi;

export function stripNestedMarkerTags(content: string): string {
  if (!content || !content.includes('<')) return content;
  return content.replace(NESTED_MARKER_TAG_REGEX, '');
}

/**
 * 流式解析结果
 */
export interface StreamingParseResult {
  markers: StreamingMarker[];
  pendingText: string; // 未能确定的尾部文本
  score: ParsedScore | null;
  /** 润色提升段落 */
  polishItems: PolishItem[];
  /** 参考范文段落（纯文本） */
  modelEssay: string | null;
}

// ============================================================================
// 不完整标记检测
// ============================================================================

/**
 * wire 协议的已知标签名（不含 polish-item/original/polished：
 * 它们只出现在 section 内部，进入本检测前 section 已被剥离）
 */
const KNOWN_TAG_NAMES = [
  'del',
  'ins',
  'replace',
  'note',
  'good',
  'err',
  'score',
  'dim',
  'section-polish',
  'section-model-essay',
];

/**
 * 判断以 '<' 开头的片段是否可能是一个已知标记的开始。
 * 正文中的裸 '<'（如 "a < b"、"<3"）返回 false，不进入 pending。
 */
function couldBeMarkerStart(fragment: string): boolean {
  let rest = fragment.slice(1);
  if (rest.startsWith('/')) rest = rest.slice(1);

  const nameMatch = rest.match(/^[a-zA-Z-]*/);
  const name = (nameMatch ? nameMatch[0] : '').toLowerCase();
  const boundaryChar = rest.charAt(name.length);

  if (boundaryChar === '') {
    // 标签名可能在 chunk 边界被截断（如 "<sec"），按前缀判断
    return KNOWN_TAG_NAMES.some((tag) => tag.startsWith(name));
  }
  // 名字后已有边界字符时必须精确匹配已知标签名
  if (/[\s>/]/.test(boundaryChar)) return KNOWN_TAG_NAMES.includes(name);
  return false;
}

/**
 * 向前回溯的最大距离：超过该距离仍未闭合的标签视为模型输出错误而非 chunk 边界，
 * 不再无限扩大 pending 区（同时限定回溯扫描的开销）。
 */
const MAX_PENDING_LOOKBEHIND = 3000;

/**
 * 在 before 之前查找 tagName 的开始标签位置，要求标签名后是合法边界字符，
 * 避免 `</err>` 误与正文中的 `<errata` 等同前缀词配对。
 */
function findPairedOpenTagBefore(lower: string, tagName: string, before: number): number {
  const token = `<${tagName}`;
  let searchFrom = before;
  while (searchFrom >= 0) {
    const pos = lower.lastIndexOf(token, searchFrom);
    if (pos === -1) return -1;
    const boundary = lower.charAt(pos + token.length);
    if (boundary === '' || /[\s>/]/.test(boundary)) return pos;
    searchFrom = pos - 1;
  }
  return -1;
}

/**
 * 检查文本末尾是否有不完整的标记，返回 pending 起始位置（-1 表示无）。
 *
 * 从尾部向前扫描 '<'：
 * - 正文裸 '<'（如 "a < b"）不是标记开始，跳过；
 * - 未闭合的已知开始标签把 pending 起点前移到该标签处；
 * - 完整闭合的结束标签直接跳到其配对的开始标签之前继续扫描，
 *   这样外层未闭合标签内已完成的内层标记（如流式中的 <score><dim>…</dim><dim…）
 *   不会截断 pending 判定。
 */
function findIncompleteMarkerStart(text: string): number {
  const lower = text.toLowerCase();
  let best = -1;
  let searchEnd = text.length;

  while (searchEnd > 0) {
    const openPos = text.lastIndexOf('<', searchEnd - 1);
    if (openPos === -1) break;
    if (text.length - openPos > MAX_PENDING_LOOKBEHIND) break;
    searchEnd = openPos;

    const fragment = text.slice(openPos);
    // 正文裸 '<'：跳过，继续向前找
    if (!couldBeMarkerStart(fragment)) continue;

    const headEnd = fragment.indexOf('>');
    if (headEnd === -1) {
      // 结束标签片段（如 "</de"）：其配对的开始标签在更前面，继续向前扫描，
      // 由那个未闭合的开始标签决定 pending 起点，避免开始标签留在确认区导致原始标签泄漏
      if (fragment.startsWith('</')) continue;
      // 开始标签头尚未接收完整
      best = openPos;
      continue;
    }

    const head = fragment.slice(0, headEnd + 1);
    // 自闭合标签（<replace .../>）自身完整，继续检查更前面的内容
    if (/\/\s*>$/.test(head)) continue;

    if (head.startsWith('</')) {
      // 完整的结束标签：跳到其配对的开始标签之前（协议无同名嵌套，取最近的同名开始标签）
      const closeNameMatch = head.match(/^<\/([a-zA-Z][a-zA-Z-]*)/);
      const tagName = closeNameMatch ? closeNameMatch[1].toLowerCase() : '';
      const pairedOpen = tagName ? findPairedOpenTagBefore(lower, tagName, openPos) : -1;
      if (pairedOpen === -1) break; // 孤儿结束标签，此前内容视为已稳定
      searchEnd = pairedOpen;
      continue;
    }

    // 普通开始标签：检查对应结束标签是否已到达
    const openNameMatch = head.match(/^<([a-zA-Z][a-zA-Z-]*)/);
    if (openNameMatch) {
      const closeTag = `</${openNameMatch[1].toLowerCase()}>`;
      if (lower.indexOf(closeTag, openPos) === -1) {
        best = openPos;
        continue;
      }
    }
    // 该开始标签已被后方结束标签闭合，之前的内容视为已稳定
    break;
  }

  return best;
}

// ============================================================================
// 完整标记解析（正则预编译，避免每次调用重建）
// ============================================================================

const DEL_REGEX = /<del(?:\s+([\s\S]*?))?>([\s\S]*?)<\/del>/gi;
const INS_REGEX = /<ins>([\s\S]*?)<\/ins>/gi;
const REPLACE_REGEX = /<replace\s+([\s\S]*?)\/>/gi;
// 畸形容错：<replace ...>（缺 '/'）成对形式与仅开始标签形式。
// 成对形式的内文限定为不含 '<'，避免与远处的孤儿 </replace> 误配而吞掉中间的合法标记
const REPLACE_MALFORMED_PAIRED_REGEX = /<replace\b([^>]*[^/\s])\s*>([^<]*)<\/replace>/gi;
const REPLACE_MALFORMED_OPEN_REGEX = /<replace\b([^>]*)>/gi;
const NOTE_REGEX = /<note\s+([\s\S]*?)>([\s\S]*?)<\/note>/gi;
const GOOD_REGEX = /<good>([\s\S]*?)<\/good>/gi;
const ERR_REGEX = /<err\s+([\s\S]*?)>([\s\S]*?)<\/err>/gi;

function buildReplaceMarker(attrs: string): StreamingMarker {
  const oldText = extractAttributeValue(attrs, 'old');
  const newText = extractAttributeValue(attrs, 'new');
  return {
    type: 'replace',
    content: `${oldText ?? ''} → ${newText ?? ''}`,
    oldText,
    newText,
    reason: extractAttributeValue(attrs, 'reason'),
    isComplete: true,
  };
}

/**
 * 解析完整的标记
 */
function parseCompleteMarkers(text: string): { markers: StreamingMarker[], remaining: string } {
  const markers: StreamingMarker[] = [];

  // 收集所有匹配
  interface MatchInfo {
    index: number;
    length: number;
    marker: StreamingMarker;
  }
  
  const allMatches: MatchInfo[] = [];
  
  // 解析各类标记
  // del
  let match;
  DEL_REGEX.lastIndex = 0;
  while ((match = DEL_REGEX.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'del',
        content: stripNestedMarkerTags(match[2]),
        reason: extractAttributeValue(match[1] || '', 'reason'),
        isComplete: true,
      },
    });
  }
  
  // ins
  INS_REGEX.lastIndex = 0;
  while ((match = INS_REGEX.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'ins',
        content: stripNestedMarkerTags(match[1]),
        isComplete: true,
      },
    });
  }
  
  // replace（规范的自闭合形式）
  REPLACE_REGEX.lastIndex = 0;
  while ((match = REPLACE_REGEX.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: buildReplaceMarker(match[1] || ''),
    });
  }

  // replace 畸形容错 1：<replace old new reason>原文</replace>（缺 '/' 的成对形式）
  REPLACE_MALFORMED_PAIRED_REGEX.lastIndex = 0;
  while ((match = REPLACE_MALFORMED_PAIRED_REGEX.exec(text)) !== null) {
    const attrs = match[1] || '';
    const marker = buildReplaceMarker(attrs);
    // 属性缺失时不产出标记，安全降级为原样文本
    if (marker.oldText === undefined && marker.newText === undefined) continue;
    allMatches.push({ index: match.index, length: match[0].length, marker });
  }

  // replace 畸形容错 2：<replace old new reason>（缺 '/' 且无结束标签）
  REPLACE_MALFORMED_OPEN_REGEX.lastIndex = 0;
  while ((match = REPLACE_MALFORMED_OPEN_REGEX.exec(text)) !== null) {
    const attrs = match[1] || '';
    // 规范自闭合形式已由 REPLACE_REGEX 处理
    if (attrs.trimEnd().endsWith('/')) continue;
    const marker = buildReplaceMarker(attrs);
    if (marker.oldText === undefined && marker.newText === undefined) continue;
    // 若同起点存在更长的成对畸形匹配，排序阶段"同起点更长优先"会让本匹配被跳过
    allMatches.push({ index: match.index, length: match[0].length, marker });
  }
  
  // note
  NOTE_REGEX.lastIndex = 0;
  while ((match = NOTE_REGEX.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'note',
        content: stripNestedMarkerTags(match[2]),
        comment: extractAttributeValue(match[1] || '', 'text'),
        isComplete: true,
      },
    });
  }
  
  // good
  GOOD_REGEX.lastIndex = 0;
  while ((match = GOOD_REGEX.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'good',
        content: stripNestedMarkerTags(match[1]),
        isComplete: true,
      },
    });
  }
  
  // err (supports both attribute orders: type/explanation or explanation/type)
  ERR_REGEX.lastIndex = 0;
  while ((match = ERR_REGEX.exec(text)) !== null) {
    const attrs = match[1] || '';
    const extractedType = extractAttributeValue(attrs, 'type');
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'err',
        content: stripNestedMarkerTags(match[2]),
        errorType: (extractedType || 'grammar') as StreamingMarker['errorType'],
        explanation: extractAttributeValue(attrs, 'explanation'),
        isComplete: true,
      },
    });
  }
  
  // 按位置排序；同起点时优先更长的匹配（与 markerParser 语义一致：外层标记优先于嵌套/局部匹配）
  allMatches.sort((a, b) => a.index - b.index || b.length - a.length);
  
  // 构建结果，处理重叠
  let processedTo = 0;
  for (const matchInfo of allMatches) {
    // 跳过与已处理区间重叠的匹配（如嵌套在 note 内部的 good）。
    // 被跳过匹配中超出已处理区间的尾部内容仍会落入后续的普通文本切片，
    // 交错场景下最多降级为原样文本显示，不会丢失内容。
    if (matchInfo.index < processedTo) {
      continue;
    }
    
    // 添加标记前的普通文本
    if (matchInfo.index > processedTo) {
      const textBefore = text.slice(processedTo, matchInfo.index);
      if (textBefore) {
        markers.push({ type: 'text', content: textBefore, isComplete: true });
      }
    }
    
    markers.push(matchInfo.marker);
    processedTo = matchInfo.index + matchInfo.length;
  }
  
  // 剩余文本
  const remaining = text.slice(processedTo);
  
  return { markers, remaining };
}

/**
 * 确认区增量解析缓存。
 *
 * 流式过程中确认区（pending 之前的文本）只会向前增长且已消费的前缀不可变
 * （未闭合的已知标签被 pending 屏蔽在确认区之外），因此可以缓存
 * "已消费前缀 → 已解析标记"，每个 chunk 只对新增后缀跑正则，
 * 避免全文 O(n²) 重扫。前缀不匹配（score/section 移除导致文本回缩、
 * 切换会话等）时自动回退全量解析并重建缓存。
 */
interface ConfirmedParseCache {
  consumedPrefix: string;
  markers: StreamingMarker[];
}

let confirmedParseCache: ConfirmedParseCache | null = null;

function parseConfirmedMarkers(
  text: string,
  allowIncremental: boolean
): { markers: StreamingMarker[]; remaining: string } {
  if (!allowIncremental) {
    confirmedParseCache = null;
    return parseCompleteMarkers(text);
  }

  const cache = confirmedParseCache;
  if (cache && cache.consumedPrefix.length > 0 && text.startsWith(cache.consumedPrefix)) {
    const suffix = text.slice(cache.consumedPrefix.length);
    const { markers: suffixMarkers, remaining } = parseCompleteMarkers(suffix);
    const consumed = suffix.length - remaining.length;
    const merged = cache.markers.concat(suffixMarkers);
    if (consumed > 0) {
      confirmedParseCache = {
        consumedPrefix: text.slice(0, cache.consumedPrefix.length + consumed),
        markers: merged.slice(),
      };
    }
    return { markers: merged, remaining };
  }

  const { markers, remaining } = parseCompleteMarkers(text);
  const consumed = text.length - remaining.length;
  confirmedParseCache = {
    consumedPrefix: text.slice(0, consumed),
    markers: markers.slice(),
  };
  return { markers, remaining };
}

// ============================================================================
// 评分解析
// ============================================================================

const SCORE_REGEX = /<score\b([^>]*)>([\s\S]*?)<\/score>/i;
// 评语惰性匹配到 </dim>，允许评语中出现 '<'（如 "a < b"）
const DIM_REGEX = /<dim\b([^>]*)>([\s\S]*?)<\/dim>/gi;

const clamp = (value: number, min: number, max: number): number =>
  Math.max(min, Math.min(value, max));

/**
 * 解析评分。
 * - <score> 与 <dim> 属性均支持任意顺序（逐属性提取）
 * - 超满分统一 clamp 到 max（与后端一致），total 与 dim 都 clamp
 *
 * 供 markerParser.parseScore 复用（统一实现，避免双份逻辑漂移）。
 */
export function parseScoreFromText(text: string): ParsedScore | null {
  const scoreMatch = text.match(SCORE_REGEX);
  if (!scoreMatch) return null;
  
  const scoreAttrs = scoreMatch[1] ?? '';
  const dimsContent = scoreMatch[2] ?? '';
  
  const total = parseFloat(extractAttributeValue(scoreAttrs, 'total') ?? '');
  const maxTotal = parseFloat(extractAttributeValue(scoreAttrs, 'max') ?? '');
  
  if (!Number.isFinite(maxTotal) || maxTotal <= 0 || !Number.isFinite(total)) return null;
  // 超满分/负分统一 clamp 到 [0, maxTotal]，与后端 clamp 行为一致
  const safeTotal = clamp(total, 0, maxTotal);
  
  // 解析维度评分（属性任意顺序）
  const dimensions: DimensionScore[] = [];
  let dimMatch;
  DIM_REGEX.lastIndex = 0;
  while ((dimMatch = DIM_REGEX.exec(dimsContent)) !== null) {
    const dimAttrs = dimMatch[1] ?? '';
    const name = extractAttributeValue(dimAttrs, 'name');
    const score = parseFloat(extractAttributeValue(dimAttrs, 'score') ?? '');
    const maxScore = parseFloat(extractAttributeValue(dimAttrs, 'max') ?? '');
    if (name && !isNaN(score) && !isNaN(maxScore) && maxScore > 0) {
      dimensions.push({
        name,
        score: clamp(score, 0, maxScore),
        maxScore,
        comment: dimMatch[2]?.trim() || undefined,
      });
    }
  }
  
  // 计算等级代码（组件层负责翻译）
  const percentage = (safeTotal / maxTotal) * 100;
  let grade: GradeCode;
  if (percentage >= 90) {
    grade = 'excellent';
  } else if (percentage >= 75) {
    grade = 'good';
  } else if (percentage >= 60) {
    grade = 'pass';
  } else {
    grade = 'fail';
  }
  
  return { total: safeTotal, maxTotal, grade, dimensions, isComplete: true };
}

/**
 * 移除评分标签（宽松匹配：不要求属性顺序/存在性，畸形 score 标签也不会泄漏到正文）
 */
export function removeScoreTag(text: string): string {
  return text.replace(/<score\b[^>]*>[\s\S]*?<\/score>/gi, '').trim();
}

// ============================================================================
// 代码块与 Markdown 清理
// ============================================================================

/**
 * 移除代码块中的内容，用占位符替换
 * 返回处理后的文本和代码块内容映射
 */
function extractCodeBlocks(text: string): { cleanText: string; codeBlocks: Map<string, string> } {
  const codeBlocks = new Map<string, string>();
  // 早退：无代码块围栏时跳过替换扫描
  if (!text.includes('```')) {
    return { cleanText: text, codeBlocks };
  }
  let counter = 0;
  
  // 匹配 ```...``` 代码块
  const cleanText = text.replace(/```[\s\S]*?```/g, (match) => {
    const placeholder = `__CODE_BLOCK_${counter++}__`;
    codeBlocks.set(placeholder, match);
    return placeholder;
  });
  
  return { cleanText, codeBlocks };
}

/**
 * 恢复单段文本中的代码块占位符。
 * 用函数形式替换，避免代码块内的 $&、$' 等被当作特殊替换模式。
 */
function restorePlaceholdersInText(content: string, codeBlocks: Map<string, string>): string {
  if (codeBlocks.size === 0 || !content.includes('__CODE_BLOCK_')) return content;
  let restored = content;
  for (const [placeholder, original] of codeBlocks) {
    restored = restored.replace(placeholder, () => original);
  }
  return restored;
}

/**
 * 清理 Markdown 语法（转为纯文本显示）
 */
function cleanMarkdownSyntax(text: string): string {
  return text
    // 移除标题标记 (# ## ### 等)
    .replace(/^#{1,6}\s+/gm, '')
    // 移除水平分隔线 (---, ***, ___)
    .replace(/^(?:---|\*\*\*|___)\s*$/gm, '')
    // 移除引用标记 (> )
    .replace(/^>\s?/gm, '')
    // 移除粗体标记
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    // 移除斜体标记
    .replace(/\*([^*]+)\*/g, '$1')
    // 移除代码块标记符（但保留内容）
    .replace(/```\w*\n?/g, '')
    // 移除行内代码标记
    .replace(/`([^`]+)`/g, '$1')
    // 移除无序列表标记 (- item, * item, + item)
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    // 移除有序列表标记 (1. item, 2. item)
    .replace(/^[\t ]*\d+\.\s+/gm, '');
}

/**
 * 后处理单个标记：恢复代码块占位符（所有类型的 content），
 * 并对普通文本清理 Markdown 语法。
 * 以标记对象身份做 WeakMap 记忆化——增量解析缓存复用的旧标记
 * 无需每个 chunk 重复跑正则（同一对象 ⇒ 同一源文本 ⇒ 同一结果）。
 */
const decoratedMarkerCache = new WeakMap<StreamingMarker, StreamingMarker>();

function decorateMarker(marker: StreamingMarker, codeBlocks: Map<string, string>): StreamingMarker {
  if (!marker.content) return marker;
  const cached = decoratedMarkerCache.get(marker);
  if (cached) return cached;

  let content = restorePlaceholdersInText(marker.content, codeBlocks);
  if (marker.type === 'text') {
    content = cleanMarkdownSyntax(content);
  }
  const decorated = content === marker.content ? marker : { ...marker, content };
  decoratedMarkerCache.set(marker, decorated);
  return decorated;
}

// ============================================================================
// 流式解析主函数
// ============================================================================

/**
 * 单槽结果缓存：同一帧内多个组件用相同输入调用时直接复用结果，
 * 避免长文全量重解析的重复开销（结果视为不可变，可安全共享引用）。
 */
let lastParseCache: { text: string; isComplete: boolean; result: StreamingParseResult } | null = null;

/**
 * 流式解析主函数
 * 
 * @param text 当前累积的全部文本
 * @param isComplete 流式是否已完成
 */
export function parseStreamingContent(text: string, isComplete: boolean): StreamingParseResult {
  if (
    lastParseCache &&
    lastParseCache.isComplete === isComplete &&
    lastParseCache.text === text
  ) {
    return lastParseCache.result;
  }
  const result = doParseStreamingContent(text, isComplete);
  lastParseCache = { text, isComplete, result };
  return result;
}

function doParseStreamingContent(text: string, isComplete: boolean): StreamingParseResult {
  // 1. 提取代码块，避免解析代码块内的标记
  const { cleanText, codeBlocks } = extractCodeBlocks(text);
  
  // 2. 先尝试解析评分（只解析第一个，忽略代码块内的）
  const score = parseScoreFromText(cleanText);
  
  // 3. 移除评分标签和 section 标签后处理剩余内容。
  //    孤儿 </score> 直接清除；流已结束时未闭合的 <score 块（流被截断）
  //    也整体剥离，避免原始标签泄漏进正文
  let contentWithoutScore = removeSectionTags(removeScoreTag(cleanText))
    .replace(/<\/score>/gi, '');
  if (isComplete) {
    contentWithoutScore = contentWithoutScore.replace(/<score\b[\s\S]*$/i, '').trimEnd();
  }
  
  // 4. 查找不完整标记的起始位置
  const incompleteStart = isComplete ? -1 : findIncompleteMarkerStart(contentWithoutScore);
  
  // 5. 分割确定部分和待定部分
  let confirmedText: string;
  let pendingText: string;
  
  if (incompleteStart === -1) {
    confirmedText = contentWithoutScore;
    pendingText = '';
  } else {
    confirmedText = contentWithoutScore.slice(0, incompleteStart);
    pendingText = contentWithoutScore.slice(incompleteStart);
  }
  
  // 6. 解析确定部分的标记（流式期间走增量缓存，完成态走确定性全量解析）
  const { markers, remaining } = parseConfirmedMarkers(confirmedText, !isComplete);
  
  // 7. 如果有剩余的确定文本，添加为普通文本（step 9 统一清理 Markdown）
  if (remaining) {
    markers.push({ type: 'text', content: remaining, isComplete: true });
  }
  
  // 8. 如果有待定文本，添加为 pending 类型
  if (pendingText) {
    pendingText = restorePlaceholdersInText(pendingText, codeBlocks);
    markers.push({ type: 'pending', content: pendingText, isComplete: false });
  }
  
  // 9. 恢复代码块占位符（所有标记的 content）并清理文本标记中的 Markdown 语法
  const cleanedMarkers = markers.map(marker => decorateMarker(marker, codeBlocks));
  
  // 10. 提取润色提升和参考范文 sections（使用 cleanText 以排除代码块内的误匹配）
  const polishItems = extractPolishItems(cleanText);
  const modelEssay = extractModelEssay(cleanText);

  return { markers: cleanedMarkers, pendingText, score, polishItems, modelEssay };
}

// ============================================================================
// Section extractors
// ============================================================================

const POLISH_SECTION_REGEX = /<section-polish>([\s\S]*?)<\/section-polish>/i;
const POLISH_ITEM_REGEX = /<polish-item>\s*<original>([\s\S]*?)<\/original>\s*<polished>([\s\S]*?)<\/polished>\s*<\/polish-item>/gi;
const MODEL_ESSAY_REGEX = /<section-model-essay>([\s\S]*?)<\/section-model-essay>/i;

/**
 * 提取 <section-polish> 中的润色项
 */
function extractPolishItems(text: string): PolishItem[] {
  const sectionMatch = text.match(POLISH_SECTION_REGEX);
  if (!sectionMatch) return [];
  const content = sectionMatch[1];
  const items: PolishItem[] = [];
  let m;
  POLISH_ITEM_REGEX.lastIndex = 0;
  while ((m = POLISH_ITEM_REGEX.exec(content)) !== null) {
    items.push({ original: m[1].trim(), polished: m[2].trim() });
  }
  return items;
}

/**
 * 提取 <section-model-essay> 中的范文文本
 */
function extractModelEssay(text: string): string | null {
  const match = text.match(MODEL_ESSAY_REGEX);
  return match ? match[1].trim() : null;
}

/**
 * 移除 section 标签（用于批注正文视图，避免 section 内容出现在主文中）
 * 开闭标签按标签名配对（反向引用 \1），避免 <section-polish>...</section-model-essay>
 * 这类交错标签被误配整段删除。
 */
export function removeSectionTags(text: string): string {
  // 早退：无 section 标签时跳过三趟替换
  if (!/<\/?section-/i.test(text)) return text.trim();
  return text
    // 完整闭合的 section 标签，开闭标签名必须一致
    .replace(/<section-(polish|model-essay)>[\s\S]*?<\/section-\1>/gi, '')
    // 流式中未闭合的 section 开始标签（含已接收的部分内容）
    .replace(/<section-(?:polish|model-essay)>[\s\S]*$/i, '')
    // 交错/畸形残留的孤儿结束标签
    .replace(/<\/section-(?:polish|model-essay)>/gi, '')
    .trim();
}

/**
 * 判断文本是否包含行内批注标记（不含 score）
 * 用于决定是否使用批注视图渲染，仅当存在 del/ins/replace/note/good/err 时才走批注视图
 */
export function hasInlineMarkers(text: string): boolean {
  const inlineMarkerPattern = /<(del|ins|replace|note|good|err)\b/i;
  return inlineMarkerPattern.test(text);
}

/**
 * 判断文本是否包含评分标记
 */
export function hasScoreMarker(text: string): boolean {
  return /<score\b/i.test(text);
}
