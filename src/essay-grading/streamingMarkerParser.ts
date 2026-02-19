/**
 * 流式标记解析器 - 支持增量解析不完整的标记符
 * 
 * 核心思路：
 * 1. 维护一个"已确认完成"的片段列表
 * 2. 维护一个"待处理"缓冲区（可能包含不完整的标记）
 * 3. 每次新数据到达时，尝试从缓冲区中解析出完整的标记
 */

import type { GradeCode } from './types';

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
  // err
  errorType?: 'grammar' | 'spelling' | 'logic' | 'expression' | 'article' | 'preposition' | 'word_form' | 'sentence_structure' | 'word_choice' | 'punctuation' | 'tense' | 'agreement';
  explanation?: string;
  // 标记是否完整
  isComplete: boolean;
}

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

/**
 * 检查文本末尾是否有不完整的标记
 */
function findIncompleteMarkerStart(text: string): number {
  // 从后向前查找最后一个 <
  const lastOpenBracket = text.lastIndexOf('<');
  if (lastOpenBracket === -1) return -1;

  const afterBracket = text.slice(lastOpenBracket);

  // < 后面没有 >，标记不完整
  if (!afterBracket.includes('>')) return lastOpenBracket;

  // 自闭合标签 (<replace ... />) — 检查其后是否还有未闭合标记
  if (afterBracket.includes('/>')) {
    const closePos = text.indexOf('/>', lastOpenBracket) + 2;
    const tail = text.slice(closePos);
    const tailResult = findIncompleteMarkerStart(tail);
    return tailResult !== -1 ? tailResult + closePos : -1;
  }

  // 开始标签 — 检查是否有对应的结束标签
  const tagMatch = afterBracket.match(/^<(\w+)/);
  if (tagMatch) {
    const closeTag = `</${tagMatch[1]}>`;
    if (!afterBracket.includes(closeTag)) return lastOpenBracket;
  }
  return -1;
}

/**
 * 解析完整的标记
 */
function parseCompleteMarkers(text: string): { markers: StreamingMarker[], remaining: string } {
  const markers: StreamingMarker[] = [];
  let remaining = text;
  let lastIndex = 0;
  
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
  const delRegex = /<del(?:\s+reason="([^"]*)")?>([\s\S]*?)<\/del>/gi;
  while ((match = delRegex.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'del',
        content: match[2],
        reason: match[1] || undefined,
        isComplete: true,
      },
    });
  }
  
  // ins
  const insRegex = /<ins>([\s\S]*?)<\/ins>/gi;
  while ((match = insRegex.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'ins',
        content: match[1],
        isComplete: true,
      },
    });
  }
  
  // replace
  const replaceRegex = /<replace\s+old="([^"]*)"\s+new="([^"]*)"(?:\s+reason="([^"]*)")?\/>/gi;
  while ((match = replaceRegex.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'replace',
        content: `${match[1]} → ${match[2]}`,
        oldText: match[1],
        newText: match[2],
        reason: match[3] || undefined,
        isComplete: true,
      },
    });
  }
  
  // note
  const noteRegex = /<note\s+text="([^"]*)">([\s\S]*?)<\/note>/gi;
  while ((match = noteRegex.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'note',
        content: match[2],
        comment: match[1],
        isComplete: true,
      },
    });
  }
  
  // good
  const goodRegex = /<good>([\s\S]*?)<\/good>/gi;
  while ((match = goodRegex.exec(text)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'good',
        content: match[1],
        isComplete: true,
      },
    });
  }
  
  // err (supports both attribute orders: type/explanation or explanation/type)
  const errRegex = /<err\s+((?:(?:type|explanation)="[^"]*?"\s*)+)>([\s\S]*?)<\/err>/gi;
  while ((match = errRegex.exec(text)) !== null) {
    const attrs = match[1];
    const typeMatch = attrs.match(/type="([^"]*?)"/);
    const explMatch = attrs.match(/explanation="([^"]*?)"/);
    allMatches.push({
      index: match.index,
      length: match[0].length,
      marker: {
        type: 'err',
        content: match[2],
        errorType: (typeMatch?.[1] || 'grammar') as StreamingMarker['errorType'],
        explanation: explMatch?.[1] || undefined,
        isComplete: true,
      },
    });
  }
  
  // 按位置排序
  allMatches.sort((a, b) => a.index - b.index);
  
  // 构建结果，处理重叠
  let processedTo = 0;
  for (const matchInfo of allMatches) {
    // 跳过已处理的部分
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
  remaining = text.slice(processedTo);
  
  return { markers, remaining };
}

/**
 * 解析评分
 */
function parseScoreFromText(text: string): ParsedScore | null {
  const scoreRegex = /<score\s+(?:total="([^"]+)"\s+max="([^"]+)"|max="([^"]+)"\s+total="([^"]+)")[^>]*>([\s\S]*?)<\/score>/i;
  const dimRegex = /<dim\s+name="([^"]+)"\s+score="([^"]+)"\s+max="([^"]+)"[^>]*>([^<]*)<\/dim>/gi;
  
  const scoreMatch = text.match(scoreRegex);
  if (!scoreMatch) return null;
  
  const totalStr = scoreMatch[1] ?? scoreMatch[4];
  const maxStr = scoreMatch[2] ?? scoreMatch[3];
  const dimsContent = scoreMatch[5] ?? '';
  
  const total = parseFloat(totalStr ?? '');
  const maxTotal = parseFloat(maxStr ?? '');
  
  if (!Number.isFinite(maxTotal) || maxTotal <= 0 || !Number.isFinite(total)) return null;
  const safeTotal = Math.max(0, Math.min(total, maxTotal));
  
  // 解析维度评分
  const dimensions: DimensionScore[] = [];
  let dimMatch;
  while ((dimMatch = dimRegex.exec(dimsContent)) !== null) {
    const score = parseFloat(dimMatch[2]);
    const maxScore = parseFloat(dimMatch[3]);
    if (!isNaN(score) && !isNaN(maxScore)) {
      dimensions.push({
        name: dimMatch[1],
        score,
        maxScore,
        comment: dimMatch[4]?.trim() || undefined,
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
 * 移除评分标签
 */
export function removeScoreTag(text: string): string {
  return text.replace(/<score\s+(?:total="[^"]+"\s+max="[^"]+"|max="[^"]+"\s+total="[^"]+")[^>]*>[\s\S]*?<\/score>/gi, '').trim();
}

/**
 * 移除代码块中的内容，用占位符替换
 * 返回处理后的文本和代码块内容映射
 */
function extractCodeBlocks(text: string): { cleanText: string; codeBlocks: Map<string, string> } {
  const codeBlocks = new Map<string, string>();
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
 * 恢复代码块内容
 */
function restoreCodeBlocks(markers: StreamingMarker[], codeBlocks: Map<string, string>): StreamingMarker[] {
  return markers.map(marker => {
    if (marker.type === 'text' && marker.content) {
      let content = marker.content;
      for (const [placeholder, original] of codeBlocks) {
        content = content.replace(placeholder, original);
      }
      return { ...marker, content };
    }
    return marker;
  });
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
 * 流式解析主函数
 * 
 * @param text 当前累积的全部文本
 * @param isComplete 流式是否已完成
 */
export function parseStreamingContent(text: string, isComplete: boolean): StreamingParseResult {
  // 1. 提取代码块，避免解析代码块内的标记
  const { cleanText, codeBlocks } = extractCodeBlocks(text);
  
  // 2. 先尝试解析评分（只解析第一个，忽略代码块内的）
  const score = parseScoreFromText(cleanText);
  
  // 3. 移除评分标签和 section 标签后处理剩余内容
  const contentWithoutScore = removeSectionTags(removeScoreTag(cleanText));
  
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
  
  // 6. 解析确定部分的标记
  const { markers, remaining } = parseCompleteMarkers(confirmedText);
  
  // 7. 如果有剩余的确定文本，添加为普通文本（step 10 统一清理 Markdown）
  if (remaining) {
    markers.push({ type: 'text', content: remaining, isComplete: true });
  }
  
  // 8. 如果有待定文本，添加为 pending 类型
  if (pendingText) {
    markers.push({ type: 'pending', content: pendingText, isComplete: false });
  }
  
  // 9. 恢复代码块内容（作为普通文本显示）
  const finalMarkers = restoreCodeBlocks(markers, codeBlocks);
  
  // 10. 清理所有文本标记中的 Markdown 语法
  const cleanedMarkers = finalMarkers.map(marker => {
    if (marker.type === 'text' && marker.content) {
      return { ...marker, content: cleanMarkdownSyntax(marker.content) };
    }
    return marker;
  });
  
  // 11. 提取润色提升和参考范文 sections（使用 cleanText 以排除代码块内的误匹配）
  const polishItems = extractPolishItems(cleanText);
  const modelEssay = extractModelEssay(cleanText);

  return { markers: cleanedMarkers, pendingText, score, polishItems, modelEssay };
}

// ============================================================================
// Section extractors
// ============================================================================

/**
 * 提取 <section-polish> 中的润色项
 */
function extractPolishItems(text: string): PolishItem[] {
  const sectionMatch = text.match(/<section-polish>([\s\S]*?)<\/section-polish>/i);
  if (!sectionMatch) return [];
  const content = sectionMatch[1];
  const items: PolishItem[] = [];
  const itemRegex = /<polish-item>\s*<original>([\s\S]*?)<\/original>\s*<polished>([\s\S]*?)<\/polished>\s*<\/polish-item>/gi;
  let m;
  while ((m = itemRegex.exec(content)) !== null) {
    items.push({ original: m[1].trim(), polished: m[2].trim() });
  }
  return items;
}

/**
 * 提取 <section-model-essay> 中的范文文本
 */
function extractModelEssay(text: string): string | null {
  const match = text.match(/<section-model-essay>([\s\S]*?)<\/section-model-essay>/i);
  return match ? match[1].trim() : null;
}

/**
 * 移除 section 标签（用于批注正文视图，避免 section 内容出现在主文中）
 */
export function removeSectionTags(text: string): string {
  return text
    // 完整闭合的 section 标签（合并两种 section 类型为单次 pass）
    .replace(/<section-(?:polish|model-essay)>[\s\S]*?<\/section-(?:polish|model-essay)>/gi, '')
    // 流式中未闭合的 section 开始标签（含已接收的部分内容）
    .replace(/<section-(?:polish|model-essay)>[\s\S]*$/gi, '')
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
