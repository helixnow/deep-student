/**
 * Marker types for essay grading
 */

/**
 * 离线解析器（markerParser.parseMarkers）实际会产出的标记类型。
 * 与 wire 协议一一对应：<del>/<ins>/<replace/>/<note>/<good>/<err>，text 为标记间的普通文本。
 */
export type ParsedMarkerType =
  | 'del'
  | 'ins'
  | 'replace'
  | 'note'
  | 'good'
  | 'err'
  | 'text';

/**
 * Legacy 类型（历史遗留，解析器从未产出，仅为兼容旧 import 保留）：
 * - 'highlight'：早期设计名，wire 协议中由 <good> 承担
 * - 'comment'：早期设计名，wire 协议中由 <note> 承担
 * - 'score'：评分不作为行内 marker 产出，走 parseScore / ParsedScore 通道
 * 请勿在新代码中使用这些成员。
 */
export type LegacyMarkerType = 'highlight' | 'comment' | 'score';

/**
 * @deprecated 新代码请使用 ParsedMarkerType（流式解析另见
 * streamingMarkerParser.MarkerType，额外含 'pending'）。
 * legacy 成员说明见 LegacyMarkerType。
 */
export type MarkerType = ParsedMarkerType | LegacyMarkerType;

/**
 * <err type="..."> 的错误类型词汇表，与后端 MARKER_INSTRUCTIONS 保持一致
 * （src-tauri/src/essay_grading/types.rs）。
 */
export type ErrorType =
  // 通用类型
  | 'grammar'
  | 'spelling'
  | 'logic'
  | 'expression'
  | 'sentence_structure'
  | 'word_choice'
  | 'punctuation'
  // 中文作文适用
  | 'idiom_misuse'
  | 'collocation'
  | 'redundancy'
  | 'ambiguity'
  | 'connective'
  | 'rhetoric'
  // 英文作文适用
  | 'article'
  | 'preposition'
  | 'tense'
  | 'agreement'
  | 'word_form';
