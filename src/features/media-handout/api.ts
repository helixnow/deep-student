/**
 * 讲义流水线的 IPC 边界：转写读取（M1 契约命令）、LLM/VLM 调用、取消、笔记资产。
 * 统一收在这里，单测只需 mock 本模块。
 */
import { invoke } from '@tauri-apps/api/core';
import { mediaTranscriptApi } from '@/features/learning-hub/apps/views/media/mediaTranscriptApi';
import type { TranscriptSegment } from './windowing';

export interface MediaTranscript {
  status: string;
  segments: TranscriptSegment[];
}

/**
 * 契约 §1.3 `media_transcript_get`，复用媒体视图的类型化封装与宽松归一化，
 * 再映射为流水线使用的数字段状态（0 待转写 / 1 完成 / 2 失败）。
 */
export async function getMediaTranscript(resourceId: string): Promise<MediaTranscript> {
  const raw = await mediaTranscriptApi.get(resourceId);
  return {
    status: raw.status,
    segments: raw.segments.map((s) => ({
      idx: s.idx,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      status: s.status === 'done' ? 1 : s.status === 'failed' ? 2 : 0,
    })),
  };
}

export function llmComplete(prompt: string, opts: { json?: boolean; runId: string }): Promise<string> {
  return invoke<string>('handout_llm_complete', {
    prompt,
    jsonMode: opts.json ?? false,
    requestId: opts.runId,
  });
}

export function vlmCaption(
  prompt: string,
  imageBase64: string,
  opts: { runId: string; mime?: string },
): Promise<string> {
  return invoke<string>('handout_vlm_caption', {
    prompt,
    imageBase64,
    mime: opts.mime ?? 'image/jpeg',
    requestId: opts.runId,
  });
}

export async function cancelRun(runId: string): Promise<void> {
  await invoke('handout_cancel', { requestId: runId }).catch(() => undefined);
}

export async function releaseRun(runId: string): Promise<void> {
  await invoke('handout_release', { requestId: runId }).catch(() => undefined);
}

/** 与编辑器图片上传同一链路（`notes_save_asset`），返回 `notes_assets/...` 相对路径 */
export async function saveNoteImage(noteId: string, base64Jpeg: string): Promise<string> {
  const saved = await invoke<{ relative_path: string }>('notes_save_asset', {
    subject: '_global',
    noteId,
    base64Data: `data:image/jpeg;base64,${base64Jpeg}`,
    defaultExt: 'jpg',
  });
  return String(saved.relative_path).replace(/\\/g, '/');
}
