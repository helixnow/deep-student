import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUpRight,
  ArrowsInSimple,
  ChatCircleText,
  PaperPlaneRight,
  Sparkle,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';

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
  { badgeKey: string; defaultBadge: string; dotClass: string }
> = {
  pdf_page: {
    badgeKey: 'miniChat.anchorKinds.pdf_page',
    defaultBadge: 'PDF 页码',
    dotClass: 'bg-info',
  },
  video_timestamp: {
    badgeKey: 'miniChat.anchorKinds.video_timestamp',
    defaultBadge: '视频时间点',
    dotClass: 'bg-success',
  },
  question_id: {
    badgeKey: 'miniChat.anchorKinds.question_id',
    defaultBadge: '题目锚点',
    dotClass: 'bg-warning',
  },
  handout_section: {
    badgeKey: 'miniChat.anchorKinds.handout_section',
    defaultBadge: '讲义章节',
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
  const { t } = useTranslation('chatV2');
  const [isMinimized, setIsMinimized] = useState<boolean>(defaultMinimized);
  const [boundAnchor, setBoundAnchor] = useState<MiniChatContextAnchor | null>(anchor);
  const [messages, setMessages] = useState<MiniChatMessage[]>(initialMessages);
  const [inputValue, setInputValue] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pillButtonRef = useRef<HTMLButtonElement | null>(null);
  const userToggledRef = useRef<boolean>(false);
  const prevMessageCountRef = useRef<number>(initialMessages.length);
  const usesDefaultPresets = presets === DEFAULT_MINI_CHAT_PRESETS;

  // 当外部传入的新锚点变化时自动同步绑定
  useEffect(() => {
    setBoundAnchor(anchor);
  }, [anchor]);

  // 胶囊 ↔ 展开面板切换后，将焦点平滑移交至输入框或胶囊按钮（首屏被动挂载不抢焦点）
  useEffect(() => {
    if (!userToggledRef.current) return undefined;
    const raf = requestAnimationFrame(() => {
      if (isMinimized) {
        pillButtonRef.current?.focus({ preventScroll: true });
      } else {
        inputRef.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [isMinimized]);

  // 当新增消息或从最小化重新展开时自动滚动消息流到底部（兼容 jsdom 中 scrollTo 未定义与减动效偏好）
  useEffect(() => {
    if (isMinimized) return;
    const container = messageListRef.current;
    if (!container) {
      prevMessageCountRef.current = messages.length;
      return;
    }
    const hasNewMessage = messages.length > prevMessageCountRef.current;
    if (hasNewMessage) {
      const prefersReduced =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({
          top: container.scrollHeight,
          behavior: prefersReduced ? 'auto' : 'smooth',
        });
      } else {
        container.scrollTop = container.scrollHeight;
      }
    } else if (userToggledRef.current && messages.length > 0) {
      container.scrollTop = container.scrollHeight;
    }
    prevMessageCountRef.current = messages.length;
  }, [messages.length, isMinimized]);

  const handleToggleMinimize = useCallback(
    (nextState: boolean) => {
      userToggledRef.current = true;
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

      const fallbackErrMsg = t('miniChat.replyFailed', {
        defaultValue: '伴读响应失败，请点击右上角「迁入主会话」继续提问。',
      });

      try {
        const result = onSendMessage?.({
          text: trimmed,
          anchor: currentAnchor,
          presetId,
        });
        if (result && typeof (result as Promise<MiniChatReplyResult>).then === 'function') {
          setIsSending(true);
          void (result as Promise<MiniChatReplyResult>)
            .then(appendAssistantReply)
            .catch((err: unknown) => {
              const errMsg = err instanceof Error ? err.message : fallbackErrMsg;
              appendAssistantReply(errMsg);
            })
            .finally(() => {
              setIsSending(false);
            });
        } else {
          appendAssistantReply(result as MiniChatReplyResult);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : fallbackErrMsg;
        appendAssistantReply(errMsg);
      }
    },
    [boundAnchor, onSendMessage, t],
  );

  const handlePresetClick = useCallback(
    (preset: MiniChatPresetAction) => {
      if (isSending) return;
      const localizedPrompt = usesDefaultPresets
        ? t(`miniChat.presets.${preset.id}.prompt`, { defaultValue: preset.promptTemplate })
        : preset.promptTemplate;
      const contextualPrefix = boundAnchor
        ? t('miniChat.anchorPrefix', {
            label: boundAnchor.label,
            defaultValue: '【{{label}}】',
          })
        : '';
      appendAndDispatchMessage(`${contextualPrefix}${localizedPrompt}`, preset.id);
    },
    [boundAnchor, appendAndDispatchMessage, isSending, t, usesDefaultPresets],
  );

  const handleSubmitForm = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputValue.trim() || isSending) return;
      appendAndDispatchMessage(inputValue);
      setInputValue('');
    },
    [inputValue, isSending, appendAndDispatchMessage],
  );

  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLElement>) => {
      if (isComposingKeyEvent(e)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleToggleMinimize(true);
      }
    },
    [handleToggleMinimize],
  );

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && isComposingKeyEvent(e)) {
      e.preventDefault();
    }
  }, []);

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
        className={cn(
          'inline-flex items-center motion-safe:animate-chat-fade-in motion-reduce:animate-none',
          className,
        )}
      >
        <DsButton
          ref={pillButtonRef}
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => handleToggleMinimize(false)}
          aria-label={t('miniChat.expandAria', { defaultValue: '展开伴读小窗' })}
          className="h-auto [@media(pointer:coarse)]:min-h-11 gap-2.5 rounded-full border-border/35 bg-card px-3.5 py-2 text-foreground shadow-sm hover:bg-muted/50 active:scale-[0.98] transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <span
            data-testid="mini-chat-unread-pulse"
            className={cn(
              'w-1.5 h-1.5 rounded-full shrink-0',
              unreadCount > 0 ? 'bg-success animate-pulse motion-reduce:animate-none' : 'bg-primary',
            )}
          />
          <ChatCircleText className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-medium">
            {t('miniChat.pillTitle', { defaultValue: '伴读小窗' })}
          </span>
          {boundAnchor && (
            <span className="text-xs text-muted-foreground max-w-[140px] truncate">
              {boundAnchor.label}
            </span>
          )}
          {unreadCount > 0 && (
            <span
              data-testid="mini-chat-unread-count"
              className="px-1.5 py-0.5 text-2xs font-mono tabular-nums rounded-full bg-success/15 text-success"
            >
              {unreadCount}
            </span>
          )}
        </DsButton>
      </div>
    );
  }

  return (
    <section
      aria-label={t('miniChat.regionAria', { defaultValue: '伴读悬浮小窗' })}
      data-testid="contextual-mini-chat"
      onKeyDown={handlePanelKeyDown}
      className={cn(
        'w-full max-w-sm rounded-xl border border-border/35 bg-card text-card-foreground shadow-lg flex flex-col overflow-hidden motion-safe:animate-chat-rise-in motion-reduce:animate-none transition-shadow duration-200 ease-standard motion-reduce:transition-none',
        className,
      )}
    >
      {/* 顶部标题栏与迁入主会话操作 */}
      <header className="flex items-center justify-between gap-2 px-3.5 py-2.5 border-b border-border/35 bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-success shrink-0" />
          <span className="text-xs font-semibold text-foreground truncate">
            {t('miniChat.headerTitle', { defaultValue: '伴读即时问答' })}
          </span>
          <span className="text-xs font-mono tabular-nums text-muted-foreground">
            ({messages.length})
          </span>
        </div>

        <div className="flex items-center gap-1">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={handlePromote}
            data-testid="promote-to-main-chat-btn"
            className="h-auto lg:h-auto [@media(pointer:coarse)]:min-h-11 gap-1 px-2 py-1 text-xs font-medium rounded border-border/35 bg-background hover:bg-muted/60 text-foreground active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <span>{t('miniChat.promoteButton', { defaultValue: '迁入主会话' })}</span>
            <ArrowUpRight className="w-3 h-3" />
          </DsButton>
          <DsButton
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => handleToggleMinimize(true)}
            aria-label={t('miniChat.minimizeAria', { defaultValue: '最小化伴读小窗' })}
            title={t('miniChat.minimizeHint', { defaultValue: '最小化伴读小窗（Esc）' })}
            className="lg:h-6 lg:w-6 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 rounded border-transparent bg-transparent hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors motion-reduce:transition-none"
          >
            <ArrowsInSimple className="w-3.5 h-3.5" />
          </DsButton>
        </div>
      </header>

      {/* 对话消息流列表 */}
      <div
        ref={messageListRef}
        data-testid="mini-chat-message-list"
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        className="flex-1 min-h-[160px] max-h-[260px] overflow-y-auto p-3 flex flex-col gap-2.5"
      >
        {messages.length === 0 ? (
          <div className="my-auto text-center py-6 px-3 flex flex-col items-center gap-1.5">
            <Sparkle className="w-4 h-4 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              {t('miniChat.emptyHint', {
                defaultValue: '已就绪，点击下方快捷指令或直接提问当前阅读内容',
              })}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                'flex flex-col gap-1 rounded-lg px-3 py-2 text-xs leading-relaxed motion-safe:animate-chat-rise-in motion-reduce:animate-none',
                msg.role === 'user'
                  ? 'bg-primary/10 text-foreground self-end max-w-[90%]'
                  : 'bg-muted/40 text-foreground self-start max-w-[92%] border border-border/35',
              )}
            >
              {msg.anchor && (
                <div className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
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
        {presets.map((preset) => {
          const presetLabel = usesDefaultPresets
            ? t(`miniChat.presets.${preset.id}.label`, { defaultValue: preset.label })
            : preset.label;
          return (
            <DsButton
              key={preset.id}
              type="button"
              variant="ghost"
              size="sm"
              disabled={isSending}
              onClick={() => handlePresetClick(preset)}
              className="h-auto lg:h-auto [@media(pointer:coarse)]:min-h-11 px-2.5 py-1 text-xs rounded-md border-border/35 bg-background hover:bg-muted/60 text-foreground active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              {presetLabel}
            </DsButton>
          );
        })}
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
              <span className="text-xs text-muted-foreground shrink-0">
                {t(ANCHOR_KIND_META[boundAnchor.kind].badgeKey, {
                  defaultValue: ANCHOR_KIND_META[boundAnchor.kind].defaultBadge,
                })}
              </span>
              <span className="h-3 w-px bg-border/35 shrink-0" />
              <span className="font-mono tabular-nums font-medium text-foreground truncate">
                {boundAnchor.label}
              </span>
            </div>
            <DsButton
              type="button"
              variant="ghost"
              size="icon"
              onClick={handleClearBoundAnchor}
              aria-label={t('miniChat.clearAnchorAria', { defaultValue: '移除上下文锚点' })}
              className="lg:h-5 lg:w-5 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11 rounded-full border-transparent bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 shrink-0 transition-colors motion-reduce:transition-none"
            >
              <X className="w-3 h-3" />
            </DsButton>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground px-1">
            {t('miniChat.noAnchor', { defaultValue: '当前未绑定上下文锚点' })}
          </div>
        )}

        {boundAnchor?.snippet && (
          <p className="text-xs text-muted-foreground line-clamp-1 px-2 border-l-2 border-primary/40">
            {t('miniChat.snippetPrefix', {
              snippet: boundAnchor.snippet,
              defaultValue: '摘录：{{snippet}}',
            })}
          </p>
        )}

        <form onSubmit={handleSubmitForm} className="flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleInputKeyDown}
            placeholder={
              boundAnchor
                ? t('miniChat.inputPlaceholder', { defaultValue: '针对当前锚点提问...' })
                : t('miniChat.inputNoAnchorPlaceholder', {
                    defaultValue: '输入伴读问题，按 Enter 发送...',
                  })
            }
            aria-label={t('miniChat.inputAria', { defaultValue: '伴读提问输入框' })}
            className="flex-1 min-w-0 min-h-11 sm:min-h-0 px-2.5 py-1.5 text-base sm:text-xs rounded-md border border-border/35 bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary transition-shadow duration-150 motion-reduce:transition-none"
          />
          <DsButton
            type="submit"
            variant="ghost"
            size="sm"
            aria-label={t('miniChat.sendAria', { defaultValue: '发送伴读提问' })}
            disabled={!inputValue.trim() || isSending}
            className="h-auto min-h-11 sm:min-h-0 lg:h-auto [@media(pointer:coarse)]:min-h-11 gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border-transparent !bg-primary !text-primary-foreground hover:!bg-primary/90 active:scale-[0.98] disabled:opacity-50 transition-[background-color,opacity,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100"
          >
            <PaperPlaneRight className="w-3 h-3" />
            <span>
              {isSending
                ? t('miniChat.sendingButton', { defaultValue: '思考中...' })
                : t('miniChat.sendButton', { defaultValue: '发送' })}
            </span>
          </DsButton>
        </form>
      </div>
    </section>
  );
};

export default ContextualMiniChat;
