/**
 * Chat V2 - 子代理嵌入视图块
 *
 * 在主代理的聊天中嵌入子代理的完整聊天视图。
 * 
 * 核心设计原则：
 * - 子代理的渲染与主代理完全相同
 * - 复用 ChatContainer（设置 showInputBar=false）
 * - 支持折叠/展开
 * - 实时显示子代理的流式响应
 * - 状态单一真相：useWorkspaceStore.agents 是子代理状态的权威来源；
 *   chat_v2_session_* 事件仅作为流式进行中的细粒度提示与回退
 */

import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import {
  CaretDown,
  CaretRight,
  Robot,
  Check,
  CheckCircle,
  CircleNotch,
  Copy,
  WarningCircle,
  XCircle,
  MinusCircle,
  Clock,
  ArrowsOut,
  ArrowsIn,
  ArrowSquareOut,
} from '@phosphor-icons/react';

import type { BlockComponentProps } from '../../registry/blockRegistry';
import { blockRegistry } from '../../registry/blockRegistry';
import { ChatContainer } from '../../components/ChatContainer';
import { cn } from '@/utils/cn';
import {
  NotionDialog,
  NotionDialogHeader,
  NotionDialogTitle,
} from '@/components/ui/NotionDialog';
// 🆕 缺口 4: 完整视图打开的调试埋点
import { logViewFullSession } from '../../debug/subagentTestPlugin';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  preheatSubagentSession,
  shouldPreheatSubagentSession,
} from './sessionPreheat';
// 🆕 P25: 导入子代理事件日志函数
import { addSubagentEventLog } from '../../debug/exportSessionDebug';
// 🆕 状态单一真相：从工作区 Store 订阅子代理状态
import { useWorkspaceStore } from '../../workspace/workspaceStore';
import { cancelAgent } from '../../workspace/api';
import type { AgentStatus, AgentCompletionEnvelope } from '../../workspace/types';

// ============================================================================
// 数据读取（类型守卫，兼容新旧后端输出格式）
// ============================================================================

/**
 * 后端 subagent_call 的 toolOutput（snake_case）：
 * - 旧格式：{ agent_session_id, workspace_id, skill_id, status: "auto_starting", ... }
 * - 新格式：额外提供 session_id（与 agent_session_id 同值）、task_summary，
 *   且 status 直接为 "running"
 * toolInput 是 LLM 原始参数 { workspace_id, skill_id, task }（没有 sessionId）。
 * 历史上还存在过 camelCase 的 SubagentEmbedInput 形态，一并兼容。
 */

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** 依次尝试多个 key，返回第一个非空字符串 */
function readString(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

/** 依次尝试多个 key，返回第一个有限数字 */
function readNumber(
  source: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

/** token 计数展示：>=1000 用 k 缩写（保留一位小数） */
function formatTokenCount(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** 已用时长展示：mm:ss，超 1 小时 h:mm:ss */
function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/** 内建 profile 三型（与后端 agent_profile.rs 的常量一致），命中则走 i18n 显示名 */
const BUILTIN_PROFILE_IDS: ReadonlySet<string> = new Set(['worker', 'explorer', 'default']);

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'completed', 'failed', 'cancelled', 'interrupted', 'closed',
]);

/**
 * 归一化后端返回的子代理状态字符串
 * - "auto_starting"（旧格式）→ 'running'
 * - 未知值 → 'running' 并 console.warn（视为进行中，避免 UI 卡在无法识别的状态）
 */
function normalizeSubagentStatus(raw: unknown): AgentStatus | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  switch (raw) {
    case 'idle':
    case 'queued':
    case 'running':
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'interrupted':
    case 'closed':
      return raw;
    case 'auto_starting':
    case 'dispatched':
      return 'running';
    default:
      console.warn(`[SubagentEmbed] Unknown subagent status "${raw}", treating as 'running'`);
      return 'running';
  }
}

/**
 * UI 展示状态：AgentStatus 之外增加中性的 'ended'。
 * 历史块没有任何终态证据时展示"已结束"，而不是伪装成成功（绿色对勾）。
 */
type SubagentDisplayStatus = AgentStatus | 'ended';

/**
 * 契约 C4 等待期进度：阻塞模式下 toolOutput 直到完成才落地，
 * 后端在派发成功后通过 tool_call chunk 流推一行 NDJSON：
 * `{"phase":"dispatched","workspace_id":"...","agent_session_id":"...","run_id":"...","status":"running"}`
 * 等待期间从 block.content 解析出会话信息才能渲染嵌入对话。
 */
interface DispatchedProgress {
  agentSessionId?: string;
  workspaceId?: string;
  runId?: string;
}

function parseDispatchedFromContent(content: string | undefined): DispatchedProgress | undefined {
  if (!content) return undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // 非 JSON 行（普通文本 chunk）静默忽略
      continue;
    }
    const record = asRecord(parsed);
    if (!record || record.phase !== 'dispatched') continue;
    return {
      agentSessionId: readString(record, 'agent_session_id'),
      workspaceId: readString(record, 'workspace_id'),
      runId: readString(record, 'run_id'),
    };
  }
  return undefined;
}

// ============================================================================
// 子代理嵌入视图组件
// ============================================================================

const SubagentEmbedBlockComponent: React.FC<BlockComponentProps> = React.memo(({ block }) => {
  const { t } = useTranslation(['chatV2', 'workspace']);
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isFullHeight, setIsFullHeight] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [copied, setCopied] = useState(false);
  // 🆕 缺口 4: 大尺寸模态中打开子代理完整会话视图
  const [isFullViewOpen, setIsFullViewOpen] = useState(false);

  // 从块数据安全读取子代理信息（兼容新旧格式）
  const input = asRecord(block.toolInput);
  // 实时路径 setBlockResult 已解包 { result, durationMs }，但历史数据可能保留包装，双重兼容
  const rawOutput = asRecord(block.toolOutput);
  const output = asRecord(rawOutput?.result) ?? rawOutput;

  // 🆕 契约 C4：等待期从 block.content 的 dispatched NDJSON 行解析会话信息
  const dispatched = useMemo(() => parseDispatchedFromContent(block.content), [block.content]);

  // session_id 来源优先级：toolOutput（新旧格式）→ dispatched NDJSON → 旧 camelCase toolInput
  const sessionId =
    readString(output, 'session_id', 'agent_session_id')
    ?? dispatched?.agentSessionId
    ?? readString(input, 'sessionId');
  const workspaceId =
    readString(output, 'workspace_id')
    ?? dispatched?.workspaceId
    ?? readString(input, 'workspace_id', 'workspaceId');
  const skillId = readString(output, 'skill_id') ?? readString(input, 'skill_id', 'skillId');
  const taskSummary =
    readString(output, 'task_summary') ?? readString(input, 'task', 'taskSummary');
  const resultSummary = readString(output, 'result_summary');
  const createdAt = readString(output, 'created_at');
  const completedAt = readString(output, 'completed_at');
  const outputStatus = normalizeSubagentStatus(output?.status);
  // 🆕 契约 C4 最终输出：output（≤4000 字符）+ output_truncated；failed 附顶层 error
  const finalOutputFromTool = readString(output, 'output');
  const outputTruncated = output?.output_truncated === true;
  const topLevelError = readString(output, 'error') ?? readString(rawOutput, 'error');
  // 🆕 契约 C7：续跑标记（resume_agent_session_id 路径的返回值携带 resumed: true）
  const isResumed = output?.resumed === true;
  // 🆕 profile 徽标：优先终态 toolOutput.profile_id，回退 LLM 入参 profile
  const profileId = readString(output, 'profile_id') ?? readString(input, 'profile');
  // 🆕 契约 C8：token 归集。外层键是 snake_case 的 token_usage，值是 camelCase TokenUsage 对象
  const tokenUsageTotalFromTool = readNumber(asRecord(output?.token_usage), 'totalTokens');

  // 🆕 状态单一真相：workspaceStore.agents 由 workspace_agent_status_changed 等事件维护
  // 选择器直接返回目标 agent 的 status（未变更时引用相同），避免无关更新触发重渲染
  const storeStatus = useWorkspaceStore((s) =>
    sessionId ? s.agents.find((a) => a.sessionId === sessionId)?.status : undefined
  );
  // 🆕 C12: inbox 未消费消息数（与 storeStatus 同源，来自 workspace_list_agents）
  const pendingInboxCount = useWorkspaceStore((s) =>
    sessionId ? s.agents.find((a) => a.sessionId === sessionId)?.pendingInboxCount : undefined
  );
  // 完成交付由运行时负责：metadata.lastCompletion（AgentCompletionEnvelope）可能比
  // 被截断的 toolOutput.output 更完整
  const storeCompletion = useWorkspaceStore((s) => {
    if (!sessionId) return undefined;
    const agent = s.agents.find((a) => a.sessionId === sessionId);
    // applyAgentCompletion 写入的即是 AgentCompletionEnvelope
    return agent?.metadata?.lastCompletion as AgentCompletionEnvelope | undefined;
  });

  // chat_v2_session_* 事件仅作为"流式进行中"的细粒度提示；终态判断以 store 为准
  const [streamHint, setStreamHint] = useState<AgentStatus | undefined>(undefined);

  // 🔧 P25 修复：子代理嵌入视图首次渲染时主动预热 Store 和 Adapter
  // 这确保 ChatContainer 渲染时 isDataLoaded=true，避免显示空白
  // 🆕 缺口 4: 折叠状态下打开完整视图模态时同样需要预热
  useEffect(() => {
    if (!shouldPreheatSubagentSession(sessionId, isCollapsed && !isFullViewOpen)) return;

    let cancelled = false;
    console.log(`[SubagentEmbed] [PREHEAT] Starting preheat for session: ${sessionId}`);
    addSubagentEventLog('preheat_start', sessionId, 'SubagentEmbed preheat starting');
    void preheatSubagentSession(sessionId, () => cancelled)
      .then(() => {
        if (!cancelled) {
          addSubagentEventLog('preheat_done', sessionId, 'SubagentEmbed preheat completed');
        }
      })
      .catch((error: unknown) => {
        console.error(`[SubagentEmbed] [PREHEAT] Failed to preheat session: ${sessionId}`, error);
        addSubagentEventLog('error', sessionId, 'SubagentEmbed preheat failed', getErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, isCollapsed, isFullViewOpen]);

  // 监听子代理会话事件（仅作为流式细粒度提示，终态以 workspaceStore 为准）
  useEffect(() => {
    if (!sessionId) return;

    // listen() 是异步的：组件可能在注册完成前卸载，
    // 用 cancelled 标记确保晚到的 unlisten 也会被立即执行，避免监听器泄漏
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    const setup = async () => {
      // 监听会话级事件通道：chat_v2_session_{sessionId}
      const eventChannel = `chat_v2_session_${sessionId}`;
      const fn = await listen<{
        sessionId: string;
        eventType: string;
        messageId?: string;
      }>(eventChannel, (event) => {
        const { eventType } = event.payload;
        console.log(`[SubagentEmbed] [EVENT] Received event: ${eventType} for session: ${sessionId}`);
        if (eventType === 'stream_start') {
          setStreamHint('running');
        } else if (eventType === 'stream_complete') {
          setStreamHint('completed');
        } else if (eventType === 'stream_error') {
          setStreamHint('failed');
        } else if (eventType === 'stream_cancelled') {
          setStreamHint('cancelled');
        }
      });
      if (cancelled) {
        fn();
      } else {
        unlisten = fn;
      }
    };

    setup();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [sessionId]);

  // 状态推导（优先级：store 单一真相 → 流式事件提示 → toolOutput 终态 → 顶层 error → 块自身状态）
  const status: SubagentDisplayStatus = useMemo(() => {
    if (storeStatus) return storeStatus;
    if (streamHint) return streamHint;
    if (outputStatus && TERMINAL_STATUSES.has(outputStatus)) return outputStatus;
    // 契约 C4：failed 附顶层 error——没有可识别 status 但有 error 也按失败渲染
    if (topLevelError) return 'failed';
    // 块自身仍在执行（subagent_call 工具尚未返回）→ 进行中
    if (block.status === 'pending' || block.status === 'running') return 'running';
    if (block.status === 'error') return 'failed';
    // 🔧 历史会话无任何终态证据（如旧格式 "auto_starting"）：
    // 展示中性"已结束"，不再兜底成 completed（可能把失败伪装成成功）
    return 'ended';
  }, [storeStatus, streamHint, outputStatus, topLevelError, block.status]);

  // 🆕 运行中已用时长：起点用 block.startedAt（createChatStore 创建块时写入的毫秒时间戳，
  // 持久化恢复路径也会带回）；历史脏数据缺失时回退组件首次挂载时刻
  const mountedAtRef = useRef<number>(Date.now());
  const elapsedBaseMs = block.startedAt ?? mountedAtRef.current;
  const isInProgress = status === 'running' || status === 'queued';
  const [elapsedMs, setElapsedMs] = useState<number>(() => Date.now() - elapsedBaseMs);
  useEffect(() => {
    if (!isInProgress) return;
    setElapsedMs(Date.now() - elapsedBaseMs);
    const timer = window.setInterval(() => {
      setElapsedMs(Date.now() - elapsedBaseMs);
    }, 1000);
    // 终态（isInProgress 变 false）或卸载时清除，React.memo 组件同样走此清理
    return () => {
      window.clearInterval(timer);
    };
  }, [isInProgress, elapsedBaseMs]);

  // 🆕 最终输出展示：store 的 lastCompletion.finalOutput 若更完整则优先
  const displayOutput = useMemo(() => {
    const fromStore = storeCompletion?.finalOutput;
    if (fromStore && (!finalOutputFromTool || fromStore.length >= finalOutputFromTool.length)) {
      return fromStore;
    }
    return finalOutputFromTool;
  }, [storeCompletion, finalOutputFromTool]);
  // 只有在展示的是被截断的 toolOutput.output 时才标注"（已截断）"
  const showTruncatedTag = outputTruncated && displayOutput === finalOutputFromTool;

  // 🆕 契约 C8：终态 token 计数（store 的 completion envelope 优先，回退 toolOutput.token_usage）
  const tokenUsageTotal = useMemo(() => {
    const fromStore = storeCompletion?.tokenUsage?.totalTokens;
    if (typeof fromStore === 'number' && Number.isFinite(fromStore)) return fromStore;
    return tokenUsageTotalFromTool;
  }, [storeCompletion, tokenUsageTotalFromTool]);
  const showTokenUsage =
    (status === 'completed' || status === 'failed') && tokenUsageTotal !== undefined;

  // 🆕 取消入口：running/queued 且已知 workspaceId + sessionId 时可取消
  const canCancel =
    (status === 'running' || status === 'queued') && Boolean(workspaceId) && Boolean(sessionId);

  const handleCancel = useCallback(async () => {
    if (isCancelling || !workspaceId || !sessionId) return;
    setIsCancelling(true);
    try {
      await cancelAgent(workspaceId, sessionId);
      showGlobalNotification('success', t('workspace:subagentEmbed.cancelRequested'));
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error(`[SubagentEmbed] Failed to cancel agent ${sessionId}:`, error);
      showGlobalNotification('error', t('workspace:subagentEmbed.cancelFailed', { msg }));
    } finally {
      setIsCancelling(false);
    }
  }, [isCancelling, workspaceId, sessionId, t]);

  // 🆕 缺口 4: 打开完整视图（附调试埋点）
  const handleOpenFullView = useCallback(() => {
    if (!sessionId) return;
    logViewFullSession(sessionId);
    setIsFullViewOpen(true);
  }, [sessionId]);

  // 🆕 profile 徽标显示名：内建三型走 i18n，自定义 id 原样显示
  const profileLabel = useMemo(() => {
    if (!profileId) return undefined;
    return BUILTIN_PROFILE_IDS.has(profileId)
      ? t(`workspace:subagentEmbed.profile.${profileId}`)
      : profileId;
  }, [profileId, t]);

  // 🆕 失败错误详情：顶层 error → store completion envelope 的 error → 通用失败文案
  const failureDetail =
    topLevelError
    ?? storeCompletion?.error
    ?? t('workspace:subagentEmbed.failedGeneric');

  // 🆕 复制最终结果：成功后 2s 内图标变 Check；卸载时清掉未触发的还原定时器
  const copyResetTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== undefined) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    };
  }, []);
  const handleCopy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        if (copyResetTimerRef.current !== undefined) {
          window.clearTimeout(copyResetTimerRef.current);
        }
        copyResetTimerRef.current = window.setTimeout(() => {
          setCopied(false);
          copyResetTimerRef.current = undefined;
        }, 2000);
      },
      (error: unknown) => {
        console.warn('[SubagentEmbed] Failed to copy final result:', error);
      }
    );
  }, []);

  // 状态图标
  const statusIcon = useMemo(() => {
    switch (status) {
      case 'running':
        return <CircleNotch size={16} className="text-primary animate-spin" />;
      case 'queued':
        return <Clock size={16} className="text-primary" />;
      case 'completed':
        return <CheckCircle size={16} className="text-success" />;
      case 'failed':
        return <WarningCircle size={16} className="text-destructive" />;
      case 'cancelled':
      case 'interrupted':
        return <XCircle size={16} className="text-warning" />;
      case 'closed':
        return <XCircle size={16} className="text-muted-foreground" />;
      case 'ended':
        return <MinusCircle size={16} className="text-muted-foreground" />;
      default:
        return <Clock size={16} className="text-muted-foreground" />;
    }
  }, [status]);

  // 状态文本
  const statusText = useMemo(() => {
    switch (status) {
      case 'running':
        return t('subagent.status.running');
      case 'queued':
        return t('subagent.status.queued');
      case 'completed':
        return t('subagent.status.completed');
      case 'failed':
        return t('subagent.status.failed');
      case 'cancelled':
        return t('subagent.status.cancelled');
      case 'interrupted':
        return t('subagent.status.interrupted');
      case 'closed':
        return t('subagent.status.closed');
      case 'ended':
        return t('workspace:subagentEmbed.ended');
      default:
        return t('subagent.status.idle');
    }
  }, [status, t]);

  // 卡片标题：优先任务摘要（截断），次选技能名，最后是会话 ID 尾巴
  const cardTitle = useMemo(() => {
    if (taskSummary) {
      const trimmed = taskSummary.trim();
      if (trimmed) {
        return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed;
      }
    }
    if (skillId) return skillId;
    if (sessionId) return `…${sessionId.slice(-8)}`;
    return t('subagent.unknownSkill');
  }, [taskSummary, skillId, sessionId, t]);

  // 实时路径：subagent_call 的 toolInput 没有 sessionId，工具返回前 output 也不存在。
  // 块仍在执行时显示"启动中"占位，而不是错误卡
  if (!sessionId) {
    const blockInProgress =
      block.isPreparing || block.status === 'pending' || block.status === 'running';
    if (blockInProgress) {
      return (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-border/50 bg-card">
          <Robot size={16} className="text-primary flex-shrink-0" />
          <span className="text-sm font-medium flex-1 truncate">{cardTitle}</span>
          <CircleNotch size={16} className="text-primary animate-spin flex-shrink-0" />
          <span className="text-xs text-muted-foreground flex-shrink-0">
            {t('subagent.status.running')}
          </span>
        </div>
      );
    }
    // 已结束但仍无 sessionId：数据确实缺失
    return (
      <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/5 border border-destructive/30">
        <WarningCircle size={16} className="text-destructive" />
        <span className="text-sm text-destructive">
          {t('subagent.noSessionId')}
        </span>
      </div>
    );
  }

  return (
    <div className={cn(
      "rounded-lg border border-border/50 bg-card overflow-hidden",
      status === 'running' && "ring-2 ring-primary/30"
    )}>
      {/* 头部：可点击折叠 */}
      <NotionButton
        variant="ghost"
        size="sm"
        onClick={() => setIsCollapsed(!isCollapsed)}
        className="w-full !justify-start gap-2 !p-3 text-left"
      >
        {/* 折叠图标 */}
        {isCollapsed ? (
          <CaretRight size={16} className="text-muted-foreground flex-shrink-0" />
        ) : (
          <CaretDown size={16} className="text-muted-foreground flex-shrink-0" />
        )}

        {/* 代理图标 */}
        <Robot size={16} className="text-primary flex-shrink-0" />

        {/* 标题：任务摘要 > 技能名 > 会话 ID 尾巴 */}
        <span className="text-sm font-medium flex-1 truncate" title={taskSummary || skillId || sessionId}>
          {cardTitle}
        </span>

        {/* 🆕 profile 徽标（与续跑标签同款 chip） */}
        {profileLabel && (
          <span className="px-1.5 py-0.5 rounded border border-border/60 text-2xs text-muted-foreground flex-shrink-0">
            {profileLabel}
          </span>
        )}

        {/* 🆕 契约 C7：续跑标记 */}
        {isResumed && (
          <span className="px-1.5 py-0.5 rounded border border-border/60 text-2xs text-muted-foreground flex-shrink-0">
            {t('workspace:subagentEmbed.resumed')}
          </span>
        )}

        {/* 🆕 C12：inbox 待消费徽标（非 running/queued 且有积压时，琥珀色） */}
        {!isInProgress && typeof pendingInboxCount === 'number' && pendingInboxCount > 0 && (
          <span
            className="px-1.5 py-0.5 rounded border border-warning/40 bg-warning/10 text-2xs text-warning flex-shrink-0"
            title={t('workspace:subagentEmbed.pendingInboxHint')}
          >
            {/* count 以字符串传入，避免 i18next 数字复数后缀解析（同 tokens chip 范式） */}
            {t('workspace:subagentEmbed.pendingInbox', { count: String(pendingInboxCount) })}
          </span>
        )}

        {/* 状态 */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {statusIcon}
          <span className="text-xs text-muted-foreground">{statusText}</span>
          {/* 🆕 运行中已用时长 */}
          {isInProgress && (
            <span className="text-2xs text-muted-foreground tabular-nums">
              {formatElapsed(elapsedMs)}
            </span>
          )}
          {/* 🆕 契约 C8：终态 token 计数 */}
          {showTokenUsage && tokenUsageTotal !== undefined && (
            <span className="text-2xs text-muted-foreground">
              {t('workspace:subagentEmbed.tokens', { count: formatTokenCount(tokenUsageTotal) })}
            </span>
          )}
        </div>

        {/* 🆕 取消按钮（running/queued 且会话信息已知时显示）——用 span 避免 button 嵌套（同尺寸切换按钮范式） */}
        {canCancel && (
          <span
            role="button"
            tabIndex={0}
            aria-disabled={isCancelling}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              void handleCancel();
            }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                void handleCancel();
              }
            }}
            className={cn(
              'px-1.5 py-0.5 rounded border border-border/60 text-xs text-muted-foreground',
              'hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer relative z-10 flex-shrink-0',
              isCancelling && 'opacity-50 pointer-events-none'
            )}
            aria-label={t('workspace:subagentEmbed.cancel')}
            title={t('workspace:subagentEmbed.cancel')}
          >
            {isCancelling ? (
              <CircleNotch size={12} className="animate-spin" />
            ) : (
              t('workspace:subagentEmbed.cancel')
            )}
          </span>
        )}

        {/* 🆕 缺口 4: 在完整视图打开——用 span 避免 button 嵌套（同高度切换按钮范式） */}
        <span
          role="button"
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            handleOpenFullView();
          }}
          onMouseDown={(e) => { e.stopPropagation(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.stopPropagation();
              e.preventDefault();
              handleOpenFullView();
            }
          }}
          className="p-1.5 rounded hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer relative z-10 flex-shrink-0 after:absolute after:-inset-2 after:content-['']"
          aria-label={t('workspace:subagentEmbed.openFull')}
          title={t('workspace:subagentEmbed.openFull')}
        >
          <ArrowSquareOut size={14} className="text-muted-foreground" />
        </span>

        {/* 高度切换按钮（仅展开时显示）——用 span 避免 button 嵌套（同 NoteToolPreview 范式），并放开强制尺寸保证触控目标 */}
        {!isCollapsed && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); setIsFullHeight(!isFullHeight); }}
            onMouseDown={(e) => { e.stopPropagation(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                setIsFullHeight(!isFullHeight);
              }
            }}
            className="p-1.5 rounded hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer relative z-10 flex-shrink-0 after:absolute after:-inset-2 after:content-['']"
            aria-label={isFullHeight ? t('subagent.collapse') : t('subagent.expand')}
            title={isFullHeight ? t('subagent.collapse') : t('subagent.expand')}
          >
            {isFullHeight ? <ArrowsIn size={14} className="text-muted-foreground" /> : <ArrowsOut size={14} className="text-muted-foreground" />}
          </span>
        )}
      </NotionButton>

      {/* 任务摘要（折叠时显示） */}
      {isCollapsed && taskSummary && (
        <div className="px-3 pb-2 text-xs text-muted-foreground line-clamp-1">
          {taskSummary}
        </div>
      )}

      {/* 结果摘要（折叠且完成时显示）：优先契约 C4 最终输出前 200 字符，回退旧 result_summary */}
      {isCollapsed && status === 'completed' && (displayOutput || resultSummary) && (
        <div className="px-3 pb-2 text-xs text-success line-clamp-2">
          {displayOutput
            ? (displayOutput.length > 200 ? `${displayOutput.slice(0, 200)}…` : displayOutput)
            : resultSummary}
        </div>
      )}

      {/* 🆕 错误摘要（折叠且失败时显示）：前 120 字符一行 */}
      {isCollapsed && status === 'failed' && (
        <div className="px-3 pb-2 text-xs text-destructive line-clamp-1">
          {failureDetail.length > 120 ? `${failureDetail.slice(0, 120)}…` : failureDetail}
        </div>
      )}

      {/* 🆕 错误详情（展开且失败时显示，位于嵌入对话上方，与最终结果同构） */}
      {!isCollapsed && status === 'failed' && (
        <div className="border-t border-destructive/30 px-3 py-2 bg-destructive/5">
          <div className="text-2xs font-medium text-destructive mb-1">
            {t('workspace:subagentEmbed.errorDetail')}
          </div>
          <div className="text-xs text-destructive whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {failureDetail}
          </div>
        </div>
      )}

      {/* 🆕 最终结果（展开且有输出时显示，位于嵌入对话上方；失败但有部分输出也照常显示） */}
      {!isCollapsed && (status === 'completed' || status === 'failed') && displayOutput && (
        <div className="border-t border-border/50 px-3 py-2 bg-muted/20">
          <div className="flex items-center text-2xs font-medium text-muted-foreground mb-1">
            <span>
              {t('workspace:subagentEmbed.finalResult')}
              {showTruncatedTag && (
                <span className="ml-1">{t('workspace:subagentEmbed.truncated')}</span>
              )}
            </span>
            {/* 🆕 复制最终结果——用 span 避免 button 嵌套（同取消按钮范式） */}
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleCopy(displayOutput);
              }}
              onMouseDown={(e) => { e.stopPropagation(); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  handleCopy(displayOutput);
                }
              }}
              className="ml-auto p-1 rounded hover:bg-[var(--interactive-hover)] transition-colors cursor-pointer flex-shrink-0 relative after:absolute after:-inset-2 after:content-['']"
              aria-label={t('workspace:subagentEmbed.copyResult')}
              title={t('workspace:subagentEmbed.copyResult')}
            >
              {copied ? (
                <Check size={12} className="text-success" />
              ) : (
                <Copy size={12} className="text-muted-foreground" />
              )}
            </span>
          </div>
          <div className="text-xs whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
            {displayOutput}
          </div>
        </div>
      )}

      {/* 嵌入的聊天视图（展开时显示） */}
      {!isCollapsed && (
        <div
          className={cn(
            // 高度用视口相对值封顶，避免小屏上嵌套滚动区超出可视范围
            "border-t border-border/50 overflow-hidden",
            isFullHeight ? "h-[min(600px,70vh)]" : "h-[min(300px,45vh)]"
          )}
        >
          {/* 
            核心复用：使用 ChatContainer 渲染子代理的完整聊天视图
            - showInputBar=false 隐藏输入栏
            - 子代理 sessionId 作为 key 确保独立 Store
          */}
          <ChatContainer
            key={sessionId}
            sessionId={sessionId}
            showInputBar={false}
            className="h-full"
          />
        </div>
      )}

      {/* 底部元信息 */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border/30 bg-muted/20 text-2xs text-muted-foreground">
        {createdAt && (
          <div className="flex items-center gap-1">
            <Clock size={12} />
            <span>{new Date(createdAt).toLocaleTimeString()}</span>
          </div>
        )}
        {completedAt && (
          <div className="flex items-center gap-1">
            <CheckCircle size={12} className="text-success" />
            <span>{new Date(completedAt).toLocaleTimeString()}</span>
          </div>
        )}
        <span className="font-mono">{sessionId.slice(-12)}</span>
      </div>

      {/* 🆕 缺口 4: 完整视图模态（NotionDialog 渲染到 portal，ESC/遮罩关闭走默认行为）
          注意：NotionDialog 桌面态内联 maxHeight 上限为 min(85vh, 720px)，
          这里用同值的 h 类名把内容撑满该上限 */}
      <NotionDialog
        open={isFullViewOpen}
        onOpenChange={setIsFullViewOpen}
        maxWidth="max-w-[min(960px,92vw)]"
        className="h-[min(85vh,720px)]"
      >
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2 pr-8">
            <Robot size={16} className="text-primary flex-shrink-0" />
            <span className="truncate" title={taskSummary || skillId || sessionId}>
              {cardTitle}
            </span>
            <span className="flex items-center gap-1.5 flex-shrink-0">
              {statusIcon}
              <span className="text-xs font-normal text-muted-foreground">{statusText}</span>
            </span>
          </NotionDialogTitle>
        </NotionDialogHeader>
        <div className="flex-1 min-h-0">
          <ChatContainer
            key={`full-${sessionId}`}
            sessionId={sessionId}
            showInputBar={false}
            className="h-full"
          />
        </div>
      </NotionDialog>
    </div>
  );
});

// ============================================================================
// 注册块类型
// ============================================================================

blockRegistry.register('subagent_embed', {
  type: 'subagent_embed',
  component: SubagentEmbedBlockComponent,
  onAbort: 'keep-content',
});

export default SubagentEmbedBlockComponent;
