/**
 * 作文批改标记符解析器
 * 
 * 支持的标记：
 * - <del reason="原因">应删除的内容</del>
 * - <ins>建议增加的内容</ins>
 * - <replace old="原文" new="修正" reason="原因"/>
 * - <note text="批注内容">被批注的原文</note>
 * - <good>优秀片段</good>
 * - <err type="grammar|spelling|logic|expression|...">错误内容</err>
 * - <score total="X" max="Y"><dim name="维度" score="X" max="Y">评语</dim></score>
 */

import type { ParsedMarkerType, ErrorType } from './markerTypes';
import {
  parseScoreFromText,
  removeScoreTag as streamingRemoveScoreTag,
  stripNestedMarkerTags,
} from './streamingMarkerParser';
import type { ParsedScore } from './streamingMarkerParser';

// Re-export GradeCode for external use
export type { GradeCode } from './types';

// ParsedScore/DimensionScore 的类型真相源在 streamingMarkerParser（含 isComplete 字段），
// 此处 re-export 以兼容既有 import（如 ScoreCard）。
export type { ParsedScore, DimensionScore } from './streamingMarkerParser';

export interface ParsedMarker {
  type: ParsedMarkerType;
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
 * 解析批改结果中的评分。
 * 直接委托给 streamingMarkerParser 的统一实现：
 * - <score>/<dim> 属性任意顺序
 * - 超满分统一 clamp 到 max（total 与 dim），与后端一致
 * - <dim> 评语允许包含 '<'
 */
export function parseScore(text: string): ParsedScore | null {
  return parseScoreFromText(text);
}

/**
 * 从文本中移除评分标签，返回纯内容（与流式解析器共用同一实现）
 */
export function removeScoreTag(text: string): string {
  return streamingRemoveScoreTag(text);
}

// 正则预编译（模块级），使用前重置 lastIndex
const PATTERNS: ReadonlyArray<{ regex: RegExp; type: ParsedMarkerType }> = [
  // <del reason="...">...</del>
  { regex: /<del(?:\s+([\s\S]*?))?>([\s\S]*?)<\/del>/gi, type: 'del' },
  // <ins>...</ins>
  { regex: /<ins>([\s\S]*?)<\/ins>/gi, type: 'ins' },
  // <replace old="..." new="..." reason="..."/>
  { regex: /<replace\s+([\s\S]*?)\/>/gi, type: 'replace' },
  // <note text="...">...</note>
  { regex: /<note\s+([\s\S]*?)>([\s\S]*?)<\/note>/gi, type: 'note' },
  // <good>...</good>
  { regex: /<good>([\s\S]*?)<\/good>/gi, type: 'good' },
  // <err type="..." explanation="...">...</err> (supports both attribute orders)
  { regex: /<err\s+([\s\S]*?)>([\s\S]*?)<\/err>/gi, type: 'err' },
];

// 畸形容错：<replace ...>（缺 '/'）成对形式与仅开始标签形式。
// 成对形式的内文限定为不含 '<'，避免与远处的孤儿 </replace> 误配而吞掉中间的合法标记
const REPLACE_MALFORMED_PAIRED_REGEX = /<replace\b([^>]*[^/\s])\s*>([^<]*)<\/replace>/gi;
const REPLACE_MALFORMED_OPEN_REGEX = /<replace\b([^>]*)>/gi;

function buildReplaceMarker(attrs: string): ParsedMarker {
  const oldText = extractAttributeValue(attrs, 'old');
  const newText = extractAttributeValue(attrs, 'new');
  return {
    type: 'replace',
    content: `${oldText ?? ''} → ${newText ?? ''}`,
    oldText,
    newText,
    reason: extractAttributeValue(attrs, 'reason'),
  };
}

/**
 * 解析批改结果中的标记符
 */
export function parseMarkers(text: string): ParsedMarker[] {
  const markers: ParsedMarker[] = [];
  let lastIndex = 0;
  
  // 收集所有匹配及其位置
  interface MatchInfo {
    index: number;
    length: number;
    marker: ParsedMarker;
  }
  
  const allMatches: MatchInfo[] = [];
  
  for (const pattern of PATTERNS) {
    let match;
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(text)) !== null) {
      const marker: ParsedMarker = { type: pattern.type, content: '' };
      
      switch (pattern.type) {
        case 'del':
          marker.reason = extractAttributeValue(match[1] || '', 'reason');
          marker.content = stripNestedMarkerTags(match[2]);
          break;
        case 'ins':
          marker.content = stripNestedMarkerTags(match[1]);
          break;
        case 'replace': {
          const built = buildReplaceMarker(match[1] || '');
          Object.assign(marker, built);
          break;
        }
        case 'note':
          marker.comment = extractAttributeValue(match[1] || '', 'text');
          marker.content = stripNestedMarkerTags(match[2]);
          break;
        case 'good':
          marker.content = stripNestedMarkerTags(match[1]);
          break;
        case 'err': {
          const attrs = match[1] || '';
          const extractedType = extractAttributeValue(attrs, 'type');
          marker.errorType = (extractedType || 'grammar') as ParsedMarker['errorType'];
          marker.explanation = extractAttributeValue(attrs, 'explanation');
          marker.content = stripNestedMarkerTags(match[2]);
          break;
        }
      }
      
      allMatches.push({
        index: match.index,
        length: match[0].length,
        marker,
      });
    }
  }
  
  // 畸形容错 1：<replace old new reason>原文</replace>（缺 '/' 的成对形式）
  let malformedMatch;
  REPLACE_MALFORMED_PAIRED_REGEX.lastIndex = 0;
  while ((malformedMatch = REPLACE_MALFORMED_PAIRED_REGEX.exec(text)) !== null) {
    const marker = buildReplaceMarker(malformedMatch[1] || '');
    // 属性缺失时不产出标记，安全降级为原样文本
    if (marker.oldText === undefined && marker.newText === undefined) continue;
    allMatches.push({ index: malformedMatch.index, length: malformedMatch[0].length, marker });
  }
  
  // 畸形容错 2：<replace old new reason>（缺 '/' 且无结束标签）
  REPLACE_MALFORMED_OPEN_REGEX.lastIndex = 0;
  while ((malformedMatch = REPLACE_MALFORMED_OPEN_REGEX.exec(text)) !== null) {
    const attrs = malformedMatch[1] || '';
    // 规范自闭合形式已由 PATTERNS 中的 replace 正则处理
    if (attrs.trimEnd().endsWith('/')) continue;
    const marker = buildReplaceMarker(attrs);
    if (marker.oldText === undefined && marker.newText === undefined) continue;
    // 若同起点存在更长的成对畸形匹配，"同起点更长优先"排序会让本匹配被跳过
    allMatches.push({ index: malformedMatch.index, length: malformedMatch[0].length, marker });
  }
  
  // 按位置排序；同起点时优先更长的匹配（外层标记优先于其内部的嵌套标记）
  allMatches.sort((a, b) => a.index - b.index || b.length - a.length);
  
  // 构建结果
  for (const matchInfo of allMatches) {
    // 跳过与已处理区间重叠的匹配（如嵌套在 note 内部的 good），避免内容重复渲染
    if (matchInfo.index < lastIndex) {
      continue;
    }
    // 添加标记前的普通文本
    if (matchInfo.index > lastIndex) {
      const textBefore = text.slice(lastIndex, matchInfo.index);
      if (textBefore.trim()) {
        markers.push({ type: 'text', content: textBefore });
      }
    }
    
    markers.push(matchInfo.marker);
    lastIndex = matchInfo.index + matchInfo.length;
  }
  
  // 添加最后的普通文本
  if (lastIndex < text.length) {
    const textAfter = text.slice(lastIndex);
    if (textAfter.trim()) {
      markers.push({ type: 'text', content: textAfter });
    }
  }
  
  // 如果没有任何标记，返回整个文本
  if (markers.length === 0) {
    markers.push({ type: 'text', content: text });
  }
  
  return markers;
}
