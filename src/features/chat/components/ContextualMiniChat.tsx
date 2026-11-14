import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  ArrowsInSimple,
  ChatCircleText,
  PaperPlaneRight,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';

// ============================================================================
// 类型与契约定义
// ============================================================================

export interface MiniChatContextAnchor {
  kind: 'pdf_page' | 'video_timestamp' | 'question_id' | 'handout_section';
  label: string;
  referenceId: string;
  snippet?: string;
}

export interface MiniChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  anchor?: MiniChatContextAnchor | null;
  createdAt?: string;
}

export interface MiniChatPresetAction {
  id: string;
  label: string;
  promptTemplate: string;
}

export type MiniChatReplyResult =
  | string
  | { content: string; anchor?: MiniChatContextAnchor | null }
  | void
  | null
  | undefined;

export interface ContextualMiniChatProps {
  anchor?: MiniChatContextAnchor | null;
  initialMessages?: MiniChatMessage[];
  defaultMinimized?: boolean;
  unreadCount?: number;
  presets?: MiniChatPresetAction[];
  onSendMessage?: (payload: {
    text: string;
    anchor: MiniChatContextAnchor | null;
    presetId?: string;
  }) => MiniChatReplyResult | Promise<MiniChatReplyResult>;
  onPromoteToMainChat?: (payload: {
    messages: MiniChatMessage[];
    anchor: MiniChatContextAnchor | null;
  }) => void;
  onClearAnchor?: () => void;
  onMinimizedChange?: (minimized: boolean) => void;
  className?: string;
}

// ============================================================================
// 默认预设指令与锚点元数据
// ============================================================================

export const DEFAULT_MINI_CHAT_PRESETS: MiniChatPresetAction[] = [
  {
    id: 'explain_paragraph',
    label: '解释当前段落',
    promptTemplate: '请结合当前上下文，用直观易懂的方式解释当前段落的核心概念与逻辑脉络。',
  },
  {
    id: 'derive_formula',
    label: '推导此步公式',
    promptTemplate: '请逐步推导当前位置的公式，写明每一步使用的定理或恒等变形条件。',
  },
  {
    id: 'generate_variant',
    label: '出一道变式题',
    promptTemplate: '请围绕当前锚点考查的知识点，命制一道难度相当的变式训练题并附简要解析。',
  },
];

const ANCHOR_KIND_META: Record<
  MiniChatContextAnchor['kind'],
  { badgeText: string; dotClass: string }
> = {
  pdf_page: {
    badgeText: 'PDF 页码',
    dotClass: 'bg-info',
  },
  video_timestamp: {
    badgeText: '视频时间点',
    dotClass: 'bg-success',
  },
  question_id: {
    badgeText: '题目锚点',
    dotClass: 'bg-warning',
  },
  handout_section: {
    badgeText: '讲义章节',
    dotClass: 'bg-primary',
  },
};

// ============================================================================
// 组件实现
// ============================================================================

export const ContextualMiniChat: React.FC<ContextualMiniChatProps> = ({
  anchor = null,
  initialMessages = [],
  defaultMinimized = false,
  unreadCount = 0,
  presets = DEFAULT_MINI_CHAT_PRESETS,
  onSendMessage,
  onPromoteToMainChat,
  onClearAnchor,
  onMinimizedChange,
  className,
}) => {
  const [isMinimized, setIsMinimized] = useState<boolean>(defaultMinimized);
  const [boundAnchor, setBoundAnchor] = useState<MiniChatContextAnchor | null>(anchor);
  const [messages, setMessages] = useState<MiniChatMessage[]>(initialMessages);
  const [inputValue, setInputValue] = useState<string>('');
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const prevMessageCountRef = useRef<number>(initialMessages.length);

  // 当外部传入的新锚点变化时自动同步绑定
  useEffect(() => {
    setBoundAnchor(anchor);
  }, [anchor]);

  // 当新增消息时自动滚动消息流到底部（兼容 jsdom 中 scrollTo 未定义的情况）
  useEffect(() => {
    if (messages.length > prevMessageCountRef.current && !isMinimized) {
      const container = messageListRef.current;
      if (container) {
        if (typeof container.scrollTo === 'function') {
          container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
        } else {
          container.scrollTop = container.scrollHeight;
        }
      }
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isMinimized]);

  const handleToggleMinimize = useCallback(
    (nextState: boolean) => {
      setIsMinimized(nextState);
      onMinimizedChange?.(nextState);
    },
    [onMinimizedChange],
  );

  const handleClearBoundAnchor = useCallback(() => {
    setBoundAnchor(null);
    onClearAnchor?.();
  }, [onClearAnchor]);

  const appendAndDispatchMessage = useCallback(
    (text: string, presetId?: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const currentAnchor = boundAnchor;
      const userMsg: MiniChatMessage = {
        id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'user',
        content: trimmed,
        anchor: currentAnchor,
      };

      setMessages((prev) => [...prev, userMsg]);

      const appendAssistantReply = (reply: MiniChatReplyResult) => {
        if (!reply) return;
        const content = typeof reply === 'string' ? reply.trim() : reply.content.trim();
        if (!content) return;
        const replyAnchor =
          typeof reply === 'string'
            ? currentAnchor
            : reply.anchor !== undefined
              ? reply.anchor
              : currentAnchor;
        const assistantMsg: MiniChatMessage = {
          id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'assistant',
          content,
          anchor: replyAnchor,
        };
        setMessages((prev) => [...prev, assistantMsg]);
      };

      try {
        const result = onSendMessage?.({
          text: trimmed,
          anchor: currentAnchor,
          presetId,
        });
        if (result && typeof (result as Promise<MiniChatReplyResult>).then === 'function') {
          void (result as Promise<MiniChatReplyResult>)
            .then(appendAssistantReply)
            .catch((err: unknown) => {
              const errMsg =
                err instanceof Error
                  ? err.message
                  : '伴读响应失败，请点击右上角「迁入主会话」继续提问。';
              appendAssistantReply(errMsg);
            });
        } else {
          appendAssistantReply(result as MiniChatReplyResult);
        }
      } catch (err: unknown) {
        const errMsg =
          err instanceof Error
            ? err.message
            : '伴读响应失败，请点击右上角「迁入主会话」继续提问。';
        appendAssistantReply(errMsg);
      }
    },
    [boundAnchor, onSendMessage],
  );

  const handlePresetClick = useCallback(
    (preset: MiniChatPresetAction) => {
      const contextualPrefix = boundAnchor ? `【${boundAnchor.label}】` : '';
      appendAndDispatchMessage(`${contextualPrefix}${preset.promptTemplate}`, preset.id);
    },
    [boundAnchor, appendAndDispatchMessage],
  );

  const handleSubmitForm = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputValue.trim()) return;
      appendAndDispatchMessage(inputValue);
      setInputValue('');
    },
    [inputValue, appendAndDispatchMessage],
  );

  const handlePromote = useCallback(() => {
    onPromoteToMainChat?.({
      messages,
      anchor: boundAnchor,
    });
  }, [messages, boundAnchor, onPromoteToMainChat]);

  // 最小化态：悬浮伴读胶囊（带 6px 未读回复脉冲点）
  if (isMinimized) {
    return (
      <div
        data-testid="contextual-mini-chat-pill"
        className={cn('inline-flex items-center', className)}
      >
        <button
          type="button"
          onClick={() => handleToggleMinimize(false)}
          aria-label="展开伴读小窗"
          className="inline-flex items-center gap-2.5 px-3.5 py-2 rounded-full border border-border/35 bg-card text-foreground shadow-sm hover:bg-muted/50 transition-colors"
        >
          <span
            data-testid="mini-chat-unread-pulse"
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              unreadCount > 0 ? 'bg-success animate-pulse' : 'bg-primary',
            )}
          />
          <ChatCircleText className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-medium">伴读小窗</span>
          {boundAnchor && (
            <span className="text-[11px] text-muted-foreground max-w-[140px] truncate">
              {boundAnchor.label}
            </span>
          )}
          {unreadCount > 0 && (
            <span
              data-testid="mini-chat-unread-count"
              className="px-1.5 py-0.5 text-[11px] font-mono tabular-nums rounded-full bg-success/15 text-success"
            >
              {unreadCount}
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <section
      aria-label="伴读悬浮小窗"
      data-testid="contextual-mini-chat"
      className={cn(
        'w-full max-w-sm rounded-xl border border-border/35 bg-card text-card-foreground shadow-lg flex flex-col overflow-hidden',
        className,
      )}
    >
      {/* 顶部标题栏与迁入主会话操作 */}
      <header className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-border/35 bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate">
            伴读即时问答
          </span>
          <span className="text-[11px] font-mono tabular-nums text-muted-foreground">
            ({messages.length})
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handlePromote}
            data-testid="promote-to-main-chat-btn"
            className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded border border-border/35 bg-background hover:bg-muted/60 text-foreground transition-colors"
          >
            <span>迁入主会话</span>
            <ArrowUpRight className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => handleToggleMinimize(true)}
            aria-label="最小化伴读小窗"
            className="p-1 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowsInSimple className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* 对话消息流列表 */}
      <div
        ref={messageListRef}
        data-testid="mini-chat-message-list"
        className="flex-1 min-h-[160px] max-h-[260px] overflow-y-auto p-3 flex flex-col gap-2.5"
      >
        {messages.length === 0 ? (
          <div className="my-auto text-center py-6 px-3 flex flex-col items-center gap-1.5">
            <Sparkle className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              已就绪，点击下方快捷指令或直接提问当前阅读内容
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'flex flex-col gap-1 rounded-lg px-3 py-2 text-xs leading-relaxed',
                msg.role === 'user'
                  ? 'bg-primary/10 text-foreground self-end max-w-[90%]'
                  : 'bg-muted/40 text-foreground self-start max-w-[92%] border border-border/35',
              )}
            >
              {msg.anchor && (
                <div className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span
                    className={cn(
                      'w-1.5 h-1.5 rounded-full',
                      ANCHOR_KIND_META[msg.anchor.kind].dotClass,
                    )}
                  />
                  <span>{msg.anchor.label}</span>
                </div>
              )}
              <div>{msg.content}</div>
            </div>
          ))
        )}
      </div>

      {/* 快捷指令预设栏 */}
      <div className="px-3 py-2 border-t border-border/35 bg-muted/10 flex flex-wrap items-center gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handlePresetClick(preset)}
            className="px-2 py-1 text-[11px] rounded-md border border-border/35 bg-background hover:bg-muted/60 text-foreground transition-colors"
          >
            {preset.label}
          </button>
        ))}
      </div>

      {/* 迷你输入框上方的上下文锚点胶囊 + 输入表单 */}
      <div className="p-3 border-t border-border/35 bg-background flex flex-col gap-2">
        {boundAnchor ? (
          <div
            data-testid="mini-chat-anchor-pill"
            className="flex items-center justify-between gap-2 px-2.5 py-1 rounded-full border border-border/35 bg-muted/30 text-xs"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span
                className={cn(
                  'w-1.5 h-1.5 rounded-full shrink-0',
                  ANCHOR_KIND_META[boundAnchor.kind].dotClass,
                )}
              />
              <span className="text-[11px] text-muted-foreground shrink-0">
                {ANCHOR_KIND_META[boundAnchor.kind].badgeText}
              </span>
              <span className="h-3 w-px bg-border/35 shrink-0" />
              <span className="font-mono tabular-nums font-medium text-foreground truncate">
                {boundAnchor.label}
              </span>
            </div>
            <button
              type="button"
              onClick={handleClearBoundAnchor}
              aria-label="移除上下文锚点"
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <div className="text-[11px] text-muted-foreground px-1">
            当前未绑定上下文锚点
          </div>
        )}

        {boundAnchor?.snippet && (
          <p className="text-[11px] text-muted-foreground line-clamp-1 px-2 border-l-2 border-primary/40">
            摘录：{boundAnchor.snippet}
          </p>
        )}

        <form onSubmit={handleSubmitForm} className="flex items-center gap-1.5">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            placeholder="针对当前锚点提问..."
            aria-label="伴读提问输入框"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-xs rounded-md border border-border/35 bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="submit"
            aria-label="发送伴读提问"
            disabled={!inputValue.trim()}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground disabled:opacity-50 transition-opacity"
          >
            <PaperPlaneRight className="w-3 h-3" />
            <span>发送</span>
          </button>
        </form>
      </div>
    </section>
  );
};

export default ContextualMiniChat;
