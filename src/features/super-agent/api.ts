/**
 * Super-agent 模式 API 层：对 Tauri 命令（chat_v2/superagent/runtime.rs）的薄封装。
 * 事件：
 * - superagent_reply    Router 对用户的新回复
 * - superagent_activity 调度活动（事件接收/过滤、Router/Worker 回合、Watchdog）
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export type WorkerStatus = 'idle' | 'running' | 'failed' | 'interrupted' | 'closed';

export interface SuperAgentWorker {
  id: string;
  threadKey: string;
  title: string;
  brief: string;
  status: WorkerStatus;
  createdMs: number;
  lastProgressMs: number;
  runStartedMs: number | null;
  runs: number;
}

export interface SuperAgentStatus {
  enabled: boolean;
  routerBusy: boolean;
  stats: {
    pendingRouter: number;
    pendingWorkers: number;
    claimed: number;
    workersTotal: number;
    workersRunning: number;
    subscriptions: number;
  };
  workers: SuperAgentWorker[];
}

export type FeedKind = 'user' | 'reply' | 'worker' | 'system';

export interface FeedItem {
  id: string;
  kind: FeedKind;
  threadKey: string;
  text: string;
  createdMs: number;
  source: string;
}

export type IngestOutcome =
  | { status: 'disabled' }
  | { status: 'dropped'; reason: string }
  | { status: 'accepted'; triggerId: string; targets: string[]; fastPath: boolean };

/** 用户与 Super-agent 对话的通道话题；后端保证它不会被绑定给 Worker。 */
export const CHAT_CHANNEL_THREAD = 'chat:main';

export const superAgentApi = {
  status: () => invoke<SuperAgentStatus>('superagent_status'),
  feed: (limit = 150) => invoke<FeedItem[]>('superagent_feed', { limit }),
  setEnabled: (enabled: boolean) => invoke<void>('superagent_set_enabled', { enabled }),
  closeWorker: (workerId: string) => invoke<void>('superagent_close_worker', { workerId }),
  reviveWorker: (workerId: string) => invoke<void>('superagent_revive_worker', { workerId }),
  /**
   * 发送一条消息。默认进入对话通道由 Router 判断；
   * 传入任务话题（worker.threadKey）则直达该任务的 Worker，不经过 Router。
   */
  send: (text: string, threadKey: string = CHAT_CHANNEL_THREAD) =>
    invoke<IngestOutcome>('superagent_ingest', {
      trigger: {
        source: 'chat',
        threadKey,
        sender: 'me',
        kind: 'message',
        body: text,
        explicitRequest: true,
      },
    }),
};

export async function subscribeSuperAgentEvents(onEvent: () => void): Promise<UnlistenFn> {
  const unlisten = await Promise.all([
    listen('superagent_reply', onEvent),
    listen('superagent_activity', onEvent),
  ]);
  return () => unlisten.forEach((u) => u());
}
