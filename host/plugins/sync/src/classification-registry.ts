/**
 * 同步分类注册表（classification.rs 逐表移植）。
 *
 * 数据按数据库拆分到 classification-data/，拼接顺序与 Rust 完全一致
 * （测试与 UI 依赖稳定顺序）。
 */
import type { TableClassification } from './classification.ts';
import { entries as vfsCore } from './classification-data/vfs-core.ts';
import { entries as vfsNotes } from './classification-data/vfs-notes.ts';
import { entries as chatV2 } from './classification-data/chat-v2.ts';
import { entries as mistakes } from './classification-data/mistakes.ts';
import { entries as llmUsage } from './classification-data/llm-usage.ts';

export function syncClassificationRegistry(): TableClassification[] {
  return [...vfsCore, ...vfsNotes, ...chatV2, ...mistakes, ...llmUsage];
}
