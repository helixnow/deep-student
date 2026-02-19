/**
 * 作文批改标记符解析器
 * 
 * 支持的标记：
 * - <del reason="原因">应删除的内容</del>
 * - <ins>建议增加的内容</ins>
 * - <replace old="原文" new="修正" reason="原因"/>
 * - <note text="批注内容">被批注的原文</note>
 * - <good>优秀片段</good>
 * - <err type="grammar|spelling|logic|expression">错误内容</err>
 * - <score total="X" max="Y"><dim name="维度" score="X" max="Y">评语</dim></score>
 */

import type { MarkerType } from './markerTypes';
import type { GradeCode } from './types';

// Re-export GradeCode for external use
export type { GradeCode } from './types';

export interface ParsedMarker {
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
}

export interface ParsedScore {
  total: number;
  maxTotal: number;
  /** 等级代码，使用 essay_grading:score.grade.{code} 获取本地化文案 */
  grade: GradeCode;
  dimensions: DimensionScore[];
}

export interface DimensionScore {
  name: string;
  score: number;
  maxScore: number;
  comment?: string;
}

/**
 * 解析批改结果中的评分
 */
export function parseScore(text: string): ParsedScore | null {
  // 匹配 <score total="X" max="Y">...</score>
  const scoreRegex = /<score\s+total="([^"]+)"\s+max="([^"]+)"[^>]*>([\s\S]*?)<\/score>/i;
  const dimRegex = /<dim\s+name="([^"]+)"\s+score="([^"]+)"\s+max="([^"]+)"[^>]*>([^<]*)<\/dim>/gi;
  
  const scoreMatch = text.match(scoreRegex);
  if (!scoreMatch) return null;
  
  const total = parseFloat(scoreMatch[1]);
  const maxTotal = parseFloat(scoreMatch[2]);
  const dimsContent = scoreMatch[3];
  
  if (isNaN(total) || isNaN(maxTotal)) return null;
  
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
  const percentage = (total / maxTotal) * 100;
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
  
  return { total, maxTotal, grade, dimensions };
}

/**
 * 从文本中移除评分标签，返回纯内容
 */
export function removeScoreTag(text: string): string {
  return text.replace(/<score\s+total="[^"]+"\s+max="[^"]+"[^>]*>[\s\S]*?<\/score>/gi, '').trim();
}

/**
 * 解析批改结果中的标记符
 */
export function parseMarkers(text: string): ParsedMarker[] {
  const markers: ParsedMarker[] = [];
  let remaining = text;
  let lastIndex = 0;
  
  // 正则表达式匹配所有标记
  const patterns = [
    // <del reason="...">...</del>
    { regex: /<del(?:\s+reason="([^"]*)")?>([\s\S]*?)<\/del>/gi, type: 'del' as MarkerType },
    // <ins>...</ins>
    { regex: /<ins>([\s\S]*?)<\/ins>/gi, type: 'ins' as MarkerType },
    // <replace old="..." new="..." reason="..."/>
    { regex: /<replace\s+old="([^"]*)"\s+new="([^"]*)"(?:\s+reason="([^"]*)")?\/>/gi, type: 'replace' as MarkerType },
    // <note text="...">...</note>
    { regex: /<note\s+text="([^"]*)">([\s\S]*?)<\/note>/gi, type: 'note' as MarkerType },
    // <good>...</good>
    { regex: /<good>([\s\S]*?)<\/good>/gi, type: 'good' as MarkerType },
    // <err type="..." explanation="...">...</err> (supports both attribute orders)
    { regex: /<err\s+((?:(?:type|explanation)="[^"]*?"\s*)+)>([\s\S]*?)<\/err>/gi, type: 'err' as MarkerType },
  ];
  
  // 收集所有匹配及其位置
  interface MatchInfo {
    index: number;
    length: number;
    marker: ParsedMarker;
  }
  
  const allMatches: MatchInfo[] = [];
  
  for (const pattern of patterns) {
    let match;
    pattern.regex.lastIndex = 0;
    while ((match = pattern.regex.exec(text)) !== null) {
      const marker: ParsedMarker = { type: pattern.type, content: '' };
      
      switch (pattern.type) {
        case 'del':
          marker.reason = match[1] || undefined;
          marker.content = match[2];
          break;
        case 'ins':
          marker.content = match[1];
          break;
        case 'replace':
          marker.oldText = match[1];
          marker.newText = match[2];
          marker.reason = match[3] || undefined;
          marker.content = `${match[1]} → ${match[2]}`;
          break;
        case 'note':
          marker.comment = match[1];
          marker.content = match[2];
          break;
        case 'good':
          marker.content = match[1];
          break;
        case 'err': {
          const attrs = match[1];
          const typeM = attrs.match(/type="([^"]*?)"/);
          const explM = attrs.match(/explanation="([^"]*?)"/);
          marker.errorType = (typeM?.[1] || 'grammar') as ParsedMarker['errorType'];
          marker.explanation = explM?.[1] || undefined;
          marker.content = match[2];
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
  
  // 按位置排序
  allMatches.sort((a, b) => a.index - b.index);
  
  // 构建结果
  for (const matchInfo of allMatches) {
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


