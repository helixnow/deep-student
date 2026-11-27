import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowsInSimple,
  ArrowUpRight,
  ChatCircleText,
  CircleNotch,
  GearSix,
  PaperPlaneRight,
  StopCircle,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { coarseHitClassFor24, coarseHitClassFor28 } from '@/components/ui/coarseHit';
import { cn } from '@/utils/cn';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import {
  type CompanionQaCitation,
  type CompanionQaResult,
  type CompanionQaTurn,
} from '../mediaCompanionQa';
import {
  CompanionAnswerRenderer,
  CompanionCitationJumpPill as CitationJumpPill,
} from './CompanionAnswerRenderer';

export interface MediaCompanionAnchor {
  kind: 'pdf_page' | 'video_timestamp' | 'question_id' | 'handout_section';
  label: string;
  referenceId: string;
  snippet?: string;
}

export interface MediaCompanionQaPreset {
  id: string;
  label: string;
  promptTemplate: string;
}

export interface MediaCompanionQaMessage {
  id: string;
  role: 'user' | 'assistant';
  kind: 'user' | 'answer' | 'unconfigured' | 'error';
  content: string;
  anchor?: MediaCompanionAnchor | null;
  citations?: CompanionQaCitation[];
  hasInlineCitations?: boolean;
  suggestSettings?: boolean;
  /** 失败重试时复用的原问题与预设 */
  retryPayload?: {
    text: string;
    presetId?: string;
  };
}

export const MEDIA_QA_DEFAULT_PRESETS: MediaCompanionQaPreset[] = [
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

export interface MediaCompanionQaCardProps {
  anchor: MediaCompanionAnchor | null;
  defaultMinimized?: boolean;
  expandSignal?: string | number | boolean;
  presets?: MediaCompanionQaPreset[];
  onAskQuestion: (payload: {
    text: string;
    anchor: MediaCompanionAnchor | null;
    presetId?: string;
    history: CompanionQaTurn[];
    requestId: string;
  }) => Promise<CompanionQaResult>;
  onCancelRequest?: (requestId: string) => void;
  onSeekTimestamp: (seconds: number) => void;
  onOpenSettings: () => void;
  onPromoteToMainChat?: (payload: {
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; anchor?: MediaCompanionAnchor | null }>;
    anchor: MediaCompanionAnchor | null;
  }) => void;
  onClearAnchor?: () => void;
  className?: string;
}

const LinkedAnswerBody: React.FC<{
  content: string;
  onSeek: (seconds: number) => void;
  jumpTitle: (label: string) => string;
}> = ({ content, onSeek, jumpTitle }) => (
  <CompanionAnswerRenderer content={content} onSeek={onSeek} jumpTitle={jumpTitle} />
);

export const MediaCompanionQaCard: React.FC<MediaCompanionQaCardProps> = ({
  anchor,
  defaultMinimized = false,
  expandSignal,
  presets = MEDIA_QA_DEFAULT_PRESETS,
  onAskQuestion,
  onCancelRequest,
  onSeekTimestamp,
  onOpenSettings,
  onPromoteToMainChat,
  onClearAnchor,
  className,
}) => {
  const { t } = useTranslation(['mediaStudio', 'chatV2', 'common']);
  const [isMinimized, setIsMinimized] = useState<boolean>(defaultMinimized);
  const [boundAnchor, setBoundAnchor] = useState<MediaCompanionAnchor | null>(anchor);
  const [messages, setMessages] = useState<MediaCompanionQaMessage[]>([]);
  const [inputValue, setInputValue] = useState<string>('');
  const [isSending, setIsSending] = useState<boolean>(false);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pillButtonRef = useRef<HTMLButtonElement | null>(null);
  const userToggledRef = useRef<boolean>(false);
  const prevMessageCountRef = useRef<number>(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const mountedRef = useRef<boolean>(true);
  const messagesRef = useRef<MediaCompanionQaMessage[]>(messages);
  messagesRef.current = messages;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeRequestIdRef.current) {
        onCancelRequest?.(activeRequestIdRef.current);
        activeRequestIdRef.current = null;
      }
    };
  }, [onCancelRequest]);

  useEffect(() => {
    setBoundAnchor(anchor);
  }, [anchor]);

  useEffect(() => {
    if (!userToggledRef.current) {
      setIsMinimized(defaultMinimized);
    }
  }, [defaultMinimized]);

  useEffect(() => {
    if (expandSignal) {
      setIsMinimized(false);
    }
  }, [expandSignal]);

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

  useEffect(() => {
    if (isMinimized) return;
    const container = messageListRef.current;
    if (!container) {
      prevMessageCountRef.current = messages.length;
      return;
    }
    const hasNewMessage = messages.length > prevMessageCountRef.current || isSending;
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
  }, [messages.length, isSending, isMinimized]);

  const handleToggleMinimize = useCallback((nextState: boolean) => {
    userToggledRef.current = true;
    setIsMinimized(nextState);
  }, []);

  const handleClearBoundAnchor = useCallback(() => {
    setBoundAnchor(null);
    onClearAnchor?.();
  }, [onClearAnchor]);

  const jumpTitle = useCallback(
    (label: string) =>
      t('mediaStudio:miniChat.jumpToTime', {
        time: label,
        defaultValue: '跳转到 {{time}}',
      }),
    [t],
  );

  const runQuestion = useCallback(
    async (text: string, options?: { presetId?: string; appendUserBubble?: boolean }) => {
      const trimmed = text.trim();
      if (!trimmed || isSending) return;

      const currentAnchor = boundAnchor;
      const history: CompanionQaTurn[] = messagesRef.current
        .filter((m) => m.kind === 'user' || m.kind === 'answer')
        .map((m) => ({ role: m.role, content: m.content }));

      if (options?.appendUserBubble !== false) {
        const userMsg: MediaCompanionQaMessage = {
          id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          role: 'user',
          kind: 'user',
          content: trimmed,
          anchor: currentAnchor,
        };
        setMessages((prev) => [...prev, userMsg]);
      }

      const requestId = `media-qa-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      activeRequestIdRef.current = requestId;
      setIsSending(true);

      try {
        const result = await onAskQuestion({
          text: trimmed,
          anchor: currentAnchor,
          presetId: options?.presetId,
          history,
          requestId,
        });
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) return;
        if (result.kind === 'cancelled') return;

        if (result.kind === 'answer') {
          setMessages((prev) => [
            ...prev,
            {
              id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: 'assistant',
              kind: 'answer',
              content: result.content,
              anchor: currentAnchor,
              citations: result.citations,
              hasInlineCitations: result.hasInlineCitations,
            },
          ]);
        } else if (result.kind === 'unconfigured') {
          setMessages((prev) => [
            ...prev,
            {
              id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: 'assistant',
              kind: 'unconfigured',
              content: result.notice,
              anchor: currentAnchor,
              citations: result.citations,
              suggestSettings: true,
            },
          ]);
        } else {
          setMessages((prev) => [
            ...prev,
            {
              id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              role: 'assistant',
              kind: 'error',
              content: result.message,
              anchor: currentAnchor,
              suggestSettings: result.suggestSettings,
              retryPayload: result.retryable
                ? { text: trimmed, presetId: options?.presetId }
                : undefined,
            },
          ]);
        }
      } catch (err: unknown) {
        if (!mountedRef.current || activeRequestIdRef.current !== requestId) return;
        const message =
          err instanceof Error && err.message.trim()
            ? err.message.trim()
            : t('mediaStudio:miniChat.requestFailed', {
                defaultValue: 'AI 伴读请求失败，请重试。',
              });
        setMessages((prev) => [
          ...prev,
          {
            id: `mini-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: 'assistant',
            kind: 'error',
            content: message,
            anchor: currentAnchor,
            retryPayload: { text: trimmed, presetId: options?.presetId },
          },
        ]);
      } finally {
        if (activeRequestIdRef.current === requestId) {
          activeRequestIdRef.current = null;
        }
        if (mountedRef.current) {
          setIsSending(false);
        }
      }
    },
    [boundAnchor, isSending, onAskQuestion, t],
  );

  const handleCancelActive = useCallback(() => {
    const reqId = activeRequestIdRef.current;
    if (!reqId) return;
    activeRequestIdRef.current = null;
    setIsSending(false);
    onCancelRequest?.(reqId);
  }, [onCancelRequest]);

  const handlePresetClick = useCallback(
    (preset: MediaCompanionQaPreset) => {
      if (isSending) return;
      const localizedPrompt = t(`chatV2:miniChat.presets.${preset.id}.prompt`, {
        defaultValue: preset.promptTemplate,
      });
      const contextualPrefix = boundAnchor
        ? t('chatV2:miniChat.anchorPrefix', {
            label: boundAnchor.label,
            defaultValue: '【{{label}}】',
          })
        : '';
      void runQuestion(`${contextualPrefix}${localizedPrompt}`, { presetId: preset.id });
    },
    [boundAnchor, isSending, runQuestion, t],
  );

  const handleSubmitForm = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!inputValue.trim() || isSending) return;
      const next = inputValue;
      setInputValue('');
      void runQuestion(next);
    },
    [inputValue, isSending, runQuestion],
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
      messages: messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        anchor: m.anchor,
      })),
      anchor: boundAnchor,
    });
  }, [messages, boundAnchor, onPromoteToMainChat]);

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
          aria-label={t('chatV2:miniChat.expandAria', { defaultValue: '展开伴读小窗' })}
          className={cn(
            coarseHitClassFor28,
            'h-auto [@media(pointer:coarse)]:!min-h-0 gap-2 rounded-full border-border/35 bg-card px-3.5 py-2 text-foreground shadow-sm hover:bg-muted/50 active:scale-[0.98] transition-[background-color,border-color,color,transform,box-shadow] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100',
          )}
        >
          <ChatCircleText className="w-3.5 h-3.5 text-primary" />
          <span className="text-xs font-medium">
            {t('chatV2:miniChat.pillTitle', { defaultValue: '伴读小窗' })}
          </span>
          {boundAnchor && (
            <span className="text-xs text-muted-foreground max-w-[140px] truncate">
              {boundAnchor.label}
            </span>
          )}
        </DsButton>
      </div>
    );
  }

  return (
    <section
      aria-label={t('chatV2:miniChat.regionAria', { defaultValue: '伴读悬浮小窗' })}
      data-testid="contextual-mini-chat"
      onKeyDown={handlePanelKeyDown}
      className={cn(
        'w-full max-w-none shrink-0 rounded-xl border border-border/35 bg-card text-card-foreground shadow-sm flex flex-col overflow-hidden motion-safe:animate-chat-rise-in motion-reduce:animate-none transition-shadow duration-200 ease-standard motion-reduce:transition-none',
        className,
      )}
    >
      {/* 顶部标题栏与迁入主会话操作 */}
      <header className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 sm:px-3.5 sm:py-2.5 border-b border-border/35 bg-muted/20">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-foreground truncate">
            {t('chatV2:miniChat.headerTitle', { defaultValue: '伴读即时问答' })}
          </span>
          <span className="text-xs font-mono tabular-nums text-muted-foreground shrink-0">
            ({messages.length})
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <DsButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={handlePromote}
            data-testid="promote-to-main-chat-btn"
            className={cn(
              coarseHitClassFor28,
              'h-auto lg:h-auto [@media(pointer:coarse)]:!min-h-0 gap-1 px-2 py-1 text-xs font-medium rounded border-border/35 bg-background hover:bg-muted/60 text-foreground active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100',
            )}
          >
            <span>{t('chatV2:miniChat.promoteButton', { defaultValue: '迁入主会话' })}</span>
            <ArrowUpRight className="w-3 h-3" />
          </DsButton>
          <DsButton
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => handleToggleMinimize(true)}
            aria-label={t('chatV2:miniChat.minimizeAria', { defaultValue: '最小化伴读小窗' })}
            title={t('chatV2:miniChat.minimizeHint', { defaultValue: '最小化伴读小窗（Esc）' })}
            className={cn(
              coarseHitClassFor24,
              'h-6 w-6 lg:h-6 lg:w-6 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 rounded border-transparent bg-transparent hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors motion-reduce:transition-none',
            )}
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
        className={cn(
          'flex-1 max-h-[280px] overflow-y-auto px-3 py-2 sm:p-3 flex flex-col gap-2.5',
          messages.length === 0 && !isSending ? 'min-h-[44px] sm:min-h-[120px]' : 'min-h-[110px] sm:min-h-[160px]',
        )}
      >
        {messages.length === 0 && !isSending ? (
          <div className="my-auto text-center py-1 sm:py-5 px-2 flex flex-col items-center gap-1">
            <ChatCircleText className="w-4 h-4 text-muted-foreground max-sm:hidden" aria-hidden="true" />
            <p className="text-xs text-muted-foreground">
              {t('mediaStudio:miniChat.emptyHint', {
                defaultValue: '基于课程字幕实时答疑，点击下方快捷指令或直接提问',
              })}
            </p>
          </div>
        ) : (
          <>
            {messages.map((msg) => {
              if (msg.kind === 'user') {
                return (
                  <div
                    key={msg.id}
                    data-media-qa-role="user"
                    className="flex flex-col gap-1 rounded-lg px-3 py-2 text-xs leading-relaxed bg-primary/10 text-foreground self-end max-w-[90%] motion-safe:animate-chat-rise-in motion-reduce:animate-none"
                  >
                    {msg.anchor && (
                      <div className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                        <span className="truncate">{msg.anchor.label}</span>
                      </div>
                    )}
                    <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                  </div>
                );
              }

              if (msg.kind === 'unconfigured') {
                return (
                  <div
                    key={msg.id}
                    data-media-qa-role="unconfigured"
                    data-testid="media-qa-unconfigured-notice"
                    className="flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed self-start w-full border border-warning/35 bg-warning/10 text-foreground motion-safe:animate-chat-rise-in motion-reduce:animate-none"
                  >
                    <div className="flex items-start gap-1.5 font-medium text-warning">
                      <WarningCircle size={15} className="shrink-0 mt-0.5" aria-hidden="true" />
                      <span>{msg.content}</span>
                    </div>
                    {msg.citations && msg.citations.length > 0 ? (
                      <ul className="flex flex-col gap-1.5 pl-0.5">
                        {msg.citations.map((cit, index) => (
                          <li key={`fb-${cit.seconds}-${index}`} className="flex items-start gap-1.5 text-xs text-foreground/90">
                            <CitationJumpPill
                              seconds={cit.seconds}
                              label={cit.label}
                              onSeek={onSeekTimestamp}
                              titleText={jumpTitle(cit.label)}
                            />
                            {cit.excerpt ? (
                              <span className="min-w-0 flex-1 break-words text-muted-foreground">
                                {cit.excerpt}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2 pt-0.5">
                      <DsButton
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onOpenSettings}
                        data-testid="media-qa-open-settings-btn"
                        className="!h-auto !min-h-0 gap-1.5 !px-2.5 !py-1 text-xs font-medium border-warning/45 bg-background hover:bg-warning/10 text-foreground"
                      >
                        <GearSix size={13} aria-hidden="true" />
                        <span>
                          {t('mediaStudio:miniChat.configureModel', {
                            defaultValue: '前往设置配置 AI 模型',
                          })}
                        </span>
                      </DsButton>
                    </div>
                  </div>
                );
              }

              if (msg.kind === 'error') {
                return (
                  <div
                    key={msg.id}
                    role="alert"
                    data-media-qa-role="error"
                    data-testid="media-qa-error"
                    className="flex flex-col gap-2 rounded-lg px-3 py-2.5 text-xs leading-relaxed self-start max-w-[96%] border border-destructive/30 bg-destructive/5 text-destructive motion-safe:animate-chat-rise-in motion-reduce:animate-none"
                  >
                    <div className="flex items-start gap-1.5">
                      <WarningCircle size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
                      <span className="min-w-0 flex-1 break-words">{msg.content}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {msg.retryPayload ? (
                        <DsButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={isSending}
                          onClick={() =>
                            void runQuestion(msg.retryPayload!.text, {
                              presetId: msg.retryPayload!.presetId,
                              appendUserBubble: false,
                            })
                          }
                          data-testid="media-qa-retry-btn"
                          className="!h-auto !min-h-0 gap-1 !px-2 !py-1 text-xs !text-destructive hover:!bg-destructive/10"
                        >
                          <ArrowClockwise size={12} aria-hidden="true" />
                          <span>{t('common:retry', { defaultValue: '重试' })}</span>
                        </DsButton>
                      ) : null}
                      {msg.suggestSettings ? (
                        <DsButton
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={onOpenSettings}
                          data-testid="media-qa-open-settings-btn"
                          className="!h-auto !min-h-0 gap-1 !px-2 !py-1 text-xs border-destructive/30 bg-background text-foreground hover:bg-muted/60"
                        >
                          <GearSix size={12} aria-hidden="true" />
                          <span>
                            {t('mediaStudio:miniChat.configureModel', {
                              defaultValue: '前往设置配置 AI 模型',
                            })}
                          </span>
                        </DsButton>
                      ) : null}
                    </div>
                  </div>
                );
              }

              // Real AI answer bubble with clickable ▶ mm:ss citations
              return (
                <div
                  key={msg.id}
                  data-media-qa-role="assistant"
                  className="flex flex-col gap-1.5 rounded-lg px-3 py-2 text-xs leading-relaxed bg-muted/40 text-foreground self-start max-w-[94%] border border-border/35 motion-safe:animate-chat-rise-in motion-reduce:animate-none"
                >
                  {msg.anchor && (
                    <div className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
                      <span className="truncate">{msg.anchor.label}</span>
                    </div>
                  )}
                  <LinkedAnswerBody
                    content={msg.content}
                    onSeek={onSeekTimestamp}
                    jumpTitle={jumpTitle}
                  />
                  {!msg.hasInlineCitations && msg.citations && msg.citations.length > 0 ? (
                    <div
                      data-testid="media-qa-reference-citations"
                      className="flex flex-wrap items-center gap-1 pt-1 border-t border-border/25 text-2xs text-muted-foreground"
                    >
                      <span>
                        {t('mediaStudio:miniChat.relatedMoments', { defaultValue: '相关片段：' })}
                      </span>
                      {msg.citations.map((cit) => (
                        <CitationJumpPill
                          key={`ref-${cit.seconds}`}
                          seconds={cit.seconds}
                          label={cit.label}
                          onSeek={onSeekTimestamp}
                          titleText={jumpTitle(cit.label)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {isSending ? (
              <div
                role="status"
                aria-live="polite"
                data-testid="media-qa-thinking"
                className="flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground bg-muted/30 border border-border/25 self-start"
              >
                <span className="inline-flex items-center gap-1.5">
                  <CircleNotch size={13} className="animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
                  <span>
                    {t('mediaStudio:miniChat.thinking', { defaultValue: 'AI 正在结合课程字幕思考…' })}
                  </span>
                </span>
                <DsButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleCancelActive}
                  data-testid="media-qa-cancel-btn"
                  aria-label={t('common:cancel', { defaultValue: '停止' })}
                  className="!h-auto !min-h-0 gap-1 !px-1.5 !py-0.5 text-2xs text-muted-foreground hover:text-foreground"
                >
                  <StopCircle size={12} aria-hidden="true" />
                  <span>{t('mediaStudio:miniChat.stop', { defaultValue: '停止' })}</span>
                </DsButton>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* 快捷指令预设栏 */}
      <div className="shrink-0 px-3 py-1.5 sm:py-2 border-t border-border/35 bg-muted/10 flex flex-nowrap sm:flex-wrap overflow-x-auto scrollbar-none items-center gap-1.5">
        {presets.map((preset) => {
          const presetLabel = t(`chatV2:miniChat.presets.${preset.id}.label`, {
            defaultValue: preset.label,
          });
          return (
            <DsButton
              key={preset.id}
              type="button"
              variant="ghost"
              size="sm"
              disabled={isSending}
              onClick={() => handlePresetClick(preset)}
              className={cn(
                coarseHitClassFor28,
                'h-auto lg:h-auto shrink-0 whitespace-nowrap [@media(pointer:coarse)]:!min-h-0 px-2.5 py-1 text-xs rounded-md border-border/35 bg-background hover:bg-muted/60 text-foreground active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100',
              )}
            >
              {presetLabel}
            </DsButton>
          );
        })}
      </div>

      {/* 上下文锚点胶囊 + 输入表单 */}
      <div className="shrink-0 p-2.5 sm:p-3 border-t border-border/35 bg-background flex flex-col gap-2">
        {boundAnchor ? (
          <div
            data-testid="mini-chat-anchor-pill"
            className="flex items-center justify-between gap-2 px-2.5 py-1 rounded-full border border-border/35 bg-muted/30 text-xs"
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-xs text-muted-foreground shrink-0">
                {t('chatV2:miniChat.anchorKinds.video_timestamp', { defaultValue: '视频时间点' })}
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
              aria-label={t('chatV2:miniChat.clearAnchorAria', { defaultValue: '移除上下文锚点' })}
              className={cn(
                coarseHitClassFor24,
                'h-5 w-5 lg:h-5 lg:w-5 [@media(pointer:coarse)]:!min-h-0 [@media(pointer:coarse)]:!min-w-0 rounded-full border-transparent bg-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50 shrink-0 transition-colors motion-reduce:transition-none',
              )}
            >
              <X className="w-3 h-3" />
            </DsButton>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground px-1">
            {t('chatV2:miniChat.noAnchor', { defaultValue: '当前未绑定上下文锚点' })}
          </div>
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
                ? t('chatV2:miniChat.inputPlaceholder', { defaultValue: '针对当前锚点提问...' })
                : t('chatV2:miniChat.inputNoAnchorPlaceholder', {
                    defaultValue: '输入伴读问题，按 Enter 发送...',
                  })
            }
            aria-label={t('chatV2:miniChat.inputAria', { defaultValue: '伴读提问输入框' })}
            className="flex-1 min-w-0 min-h-11 sm:min-h-0 px-2.5 py-1.5 text-base sm:text-xs rounded-md border border-border/35 bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary transition-shadow duration-150 motion-reduce:transition-none"
          />
          <DsButton
            type="submit"
            variant="ghost"
            size="sm"
            aria-label={t('chatV2:miniChat.sendAria', { defaultValue: '发送伴读提问' })}
            disabled={!inputValue.trim() || isSending}
            className={cn(
              coarseHitClassFor28,
              'h-auto lg:h-auto [@media(pointer:coarse)]:!min-h-0 gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border-transparent !bg-primary !text-primary-foreground hover:!bg-primary/90 active:scale-[0.98] disabled:opacity-50 transition-[background-color,opacity,transform] duration-150 ease-standard motion-reduce:transition-none motion-reduce:active:scale-100',
            )}
          >
            <PaperPlaneRight className="w-3 h-3" />
            <span>
              {isSending
                ? t('chatV2:miniChat.sendingButton', { defaultValue: '思考中...' })
                : t('chatV2:miniChat.sendButton', { defaultValue: '发送' })}
            </span>
          </DsButton>
        </form>
      </div>
    </section>
  );
};

export default MediaCompanionQaCard;
