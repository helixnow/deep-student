import type { ComponentType } from 'react';
import type { Super } from '../overlays/Supers';

/** [段内脚本秒, 音效名（同 audio/Soundtrack.tsx 的 Sfx）, 层级, 相对层级的增减 dB] */
export type InsertCue = [time: number, sfx: string, tier: 'hero' | 'cue' | 'ui' | 'tex', accent?: number];

/**
 * 插入段：在原片某个切入点插进去的一段新镜头。原有镜头的节拍常量（各 beats.ts 里的绝对脚本秒）不改，
 * 新增时长一律以插入段登记；成片时间轴按登记表把原片时间让开。
 */
export type InsertScene = {
  /** 只含字母、数字、连字符；检查用合成名为 Insert-<id> */
  id: string;
  /** 切入点：原片的脚本秒。原片画面停在这一刻，段落播完后从这一刻继续 */
  at: number;
  /** 段长（脚本秒；成片秒 = × PACE） */
  dur: number;
  /** t 为段内脚本秒（0…dur）。画面盖在停住的原片之上，入场与退场的过渡由段落自己负责 */
  Scene: ComponentType<{ t: number }>;
  /** 段内字幕，s / e / at 都是段内脚本秒 */
  supers?: Super[];
  cues?: InsertCue[];
};
