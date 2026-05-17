/**
 * 翻译弹窗共享类型定义
 */

export interface AlignedSegment {
  src: string;
  tgt: string;
}

export type TranslationDisplayMode = 'aligned' | 'streaming';
