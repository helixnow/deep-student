/**
 * MediaStudyView 的「伴随面板」扩展点（音视频子应用，docs/dev/media-learning §0.5）
 *
 * 宿主（音视频子应用学习页）经 context 注入额外分区（讲义 / 问答 / 练习），媒体视图
 * 把字幕面板与这些分区合成同一块分段面板：桌面在播放器右侧，手机在播放器下方。
 * 资源库 / 聊天右侧面板不提供 context，保持原有布局——同一个播放器、同一套转写逻辑。
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { TranscriptSegment, TranscriptStatus } from './mediaTranscriptApi';
import type { MediaChapter } from './mediaChapters';

/** 字幕分区固定 id（默认分区） */
export const MEDIA_STUDY_TRANSCRIPT_TAB = 'transcript';

export interface MediaStudyCompanionRenderContext {
  resourceId: string;
  kind: 'audio' | 'video';
  /** 播放器所用的同一 URL（讲义抽帧需要） */
  src: string;
  fileName: string;
  transcriptStatus: TranscriptStatus;
  /** 有已完成的字幕段且不在转写中（讲义 / 问答的前提） */
  hasTranscript: boolean;
  /** 已完成段数 / 计划段数 */
  doneSegments: number;
  totalSegments: number;
  /** 全部字幕段（含待转写 / 失败段，按 idx 序） */
  segments: readonly TranscriptSegment[];
  /** 讲义章节（最新讲义的小节起点）与当前所在章节下标（-1 = 第一章之前 / 无章节） */
  chapters: readonly MediaChapter[];
  currentChapterIndex: number;
  seekTo: (seconds: number) => void;
  /** 播放器当前时间（秒）；「问刚才这段」等按此刻取字幕 */
  getCurrentTime: () => number;
}

export interface MediaStudyCompanionTab {
  id: string;
  label: string;
  render: (ctx: MediaStudyCompanionRenderContext) => ReactNode;
}

export interface MediaStudyCompanionValue {
  tabs: readonly MediaStudyCompanionTab[];
  /** 当前分区（MEDIA_STUDY_TRANSCRIPT_TAB 或 tabs[].id） */
  activeTab: string;
  onActiveTabChange: (tabId: string) => void;
  /** 分段控件可访问名 */
  ariaLabel: string;
}

export const MediaStudyCompanionContext = createContext<MediaStudyCompanionValue | null>(null);

export function useMediaStudyCompanion(): MediaStudyCompanionValue | null {
  return useContext(MediaStudyCompanionContext);
}
