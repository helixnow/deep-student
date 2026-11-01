/**
 * SuperAgentPage —— Super-agent 模式（实验性）。
 *
 * 与普通“按 Session 的会话模式”的区别：
 * - 只有**一个**持续的对话流，没有会话列表、没有“新建会话”；底层 Session 对用户不可见。
 * - 你可以连续抛出多件事，不必等上一件做完；后台 Worker 并行推进，进展在右侧“任务”里。
 * - 追问不需要记得“在哪个会话里”：直接在对话里说，Router 会判断并转交给对应任务；
 *   也可以直接在某个任务卡片里回复，消息会直达该任务的 Worker。
 * - 窗口关闭到托盘后仍在后台工作（走 headless 管线，只读工具面）。
 */
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useMobileHeader } from '@/components/layout';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { DsButton } from '@/components/ui/DsButton';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Badge } from '@/components/ui/shad/Badge';
import type { FeedItem, SuperAgentWorker, WorkerStatus } from './api';
import { useSuperAgent } from './useSuperAgent';
import { useSuperAgentEnabledStore } from './enabledStore';

interface SuperAgentPageProps {
  /** 页面当前是否可见（不可见时暂停轮询） */
  isActive?: boolean;
}

const STATUS_VARIANT: Record<WorkerStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  idle: 'secondary',
  running: 'default',
  failed: 'destructive',
  interrupted: 'destructive',
  closed: 'outline',
};

function formatTime(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function firstLine(text: string, max = 80): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

// ---------------------------------------------------------------------------
// 时间线条目
// ---------------------------------------------------------------------------

const FeedRow: React.FC<{ item: FeedItem }> = ({ item }) => {
  const { t } = useTranslation('superAgent');
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-2xl rounded-br-md bg-primary/10 px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
          {item.text}
          <div className="mt-1 text-right text-2xs text-muted-foreground">{formatTime(item.createdMs)}</div>
        </div>
      </div>
    );
  }
  if (item.kind === 'reply') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] rounded-2xl rounded-bl-md border border-border bg-card px-3.5 py-2 text-sm whitespace-pre-wrap break-words">
          {item.text}
          <div className="mt-1 text-2xs text-muted-foreground">{formatTime(item.createdMs)}</div>
        </div>
      </div>
    );
  }
  // worker / system：折叠的进展条，避免把 Worker 的推理细节倾倒在对话里
  return (
    <details className="group mx-auto w-full max-w-[88%] rounded-lg border border-dashed border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
      <summary className="cursor-pointer list-none truncate">
        <span className="mr-1.5 opacity-70">{item.kind === 'worker' ? t('feed.worker') : t('feed.system')}</span>
        {firstLine(item.text.replace(/^Worker\s+\S+\s+/, ''))}
        <span className="ml-2 opacity-60">{formatTime(item.createdMs)}</span>
      </summary>
      <div className="mt-1.5 whitespace-pre-wrap break-words text-foreground/80">{item.text}</div>
    </details>
  );
};

// ---------------------------------------------------------------------------
// 任务（Worker）卡片
// ---------------------------------------------------------------------------

const WorkerCard: React.FC<{
  worker: SuperAgentWorker;
  onClose: (id: string) => void;
  onRevive: (id: string) => void;
  onSend: (text: string, threadKey: string) => Promise<unknown>;
}> = ({ worker, onClose, onRevive, onSend }) => {
  const { t } = useTranslation('superAgent');
  const [replying, setReplying] = useState(false);
  const [draft, setDraft] = useState('');
  const needsAttention = worker.status === 'failed' || worker.status === 'interrupted';

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setReplying(false);
    await onSend(text, worker.threadKey);
  };

  return (
    <div className="rounded-xl border border-border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{worker.title}</div>
          <div className="mt-0.5 truncate text-2xs text-muted-foreground">{worker.threadKey}</div>
        </div>
        <Badge variant={STATUS_VARIANT[worker.status]}>{t(`workerStatus.${worker.status}`)}</Badge>
      </div>
      <div className="mt-1.5 text-2xs text-muted-foreground">
        {t('worker.meta', { runs: worker.runs, time: formatTime(worker.lastProgressMs) })}
      </div>
      {replying ? (
        <div className="mt-2 space-y-1.5">
          <Textarea
            autoFocus
            rows={2}
            value={draft}
            placeholder={t('worker.replyPlaceholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
            }}
            className="min-h-[56px] text-sm"
          />
          <div className="flex justify-end gap-1.5">
            <DsButton size="sm" variant="ghost" onClick={() => setReplying(false)}>
              {t('common.cancel')}
            </DsButton>
            <DsButton size="sm" onClick={() => void submit()} disabled={!draft.trim()}>
              {t('worker.sendDirect')}
            </DsButton>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <DsButton size="sm" variant="ghost" onClick={() => setReplying(true)}>
            {t('worker.reply')}
          </DsButton>
          {needsAttention && (
            <DsButton size="sm" variant="ghost" onClick={() => onRevive(worker.id)}>
              {t('worker.retry')}
            </DsButton>
          )}
          <DsButton size="sm" variant="ghost" onClick={() => onClose(worker.id)}>
            {t('worker.close')}
          </DsButton>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// 页面
// ---------------------------------------------------------------------------

export const SuperAgentPage: React.FC<SuperAgentPageProps> = ({ isActive = true }) => {
  const { t } = useTranslation('superAgent');
  // 移动端统一顶栏：由 useViewLayerContents 外层 MobilePageScaffold 渲染（返回 + 标题）
  useMobileHeader('super-agent', { title: 'Super-agent' });
  const { status, feed, error, sending, thinking, send, closeWorker, reviveWorker } =
    useSuperAgent(isActive);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const enabled = status?.enabled ?? false;
  useEffect(() => {
    if (status) useSuperAgentEnabledStore.getState().setMirror(status.enabled);
  }, [status?.enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  const workers = useMemo(() => (status?.workers ?? []).filter((w) => w.status !== 'closed'), [status]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [feed.length, thinking]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const handleSend = async (text: string, threadKey?: string) => {
    const outcome = await send(text, threadKey);
    if (outcome?.status === 'dropped') setNotice(t('notice.dropped', { reason: outcome.reason }));
    if (outcome?.status === 'disabled') setNotice(t('notice.disabled'));
    return outcome;
  };

  const submitMain = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setDraft('');
    stickToBottom.current = true;
    await handleSend(text);
  };

  return (
    <div className="flex h-full min-h-0 w-full bg-background text-foreground">
      {/* 主对话流 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold">{t('title')}</h1>
              <Badge variant="outline">{t('experimental')}</Badge>
            </div>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('subtitle')}</p>
          </div>
        </header>

        {!enabled ? (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="max-w-md space-y-3 text-center">
              <h2 className="text-base font-semibold">{t('intro.heading')}</h2>
              <ul className="space-y-1.5 text-left text-sm text-muted-foreground">
                <li>• {t('intro.continuous')}</li>
                <li>• {t('intro.parallel')}</li>
                <li>• {t('intro.background')}</li>
                <li>• {t('intro.safe')}</li>
              </ul>
              <p className="text-xs text-muted-foreground">{t('intro.enableInSettings')}</p>
              <DsButton
                onClick={() => dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'settings' })}
              >
                {t('intro.openSettings')}
              </DsButton>
            </div>
          </div>
        ) : (
          <>
            <div
              ref={scrollRef}
              className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              }}
            >
              {feed.length === 0 && !thinking && (
                <div className="mt-16 text-center text-sm text-muted-foreground">{t('empty')}</div>
              )}
              {feed.map((item) => (
                <FeedRow key={`${item.kind}:${item.id}`} item={item} />
              ))}
              {thinking && (
                <div className="flex justify-start">
                  <div className="rounded-2xl rounded-bl-md border border-border px-3.5 py-2 text-xs text-muted-foreground">
                    {t('thinking')}
                  </div>
                </div>
              )}
            </div>

            {(error || notice) && (
              <div
                className={cn(
                  'mx-4 mb-1 rounded-md px-3 py-1.5 text-xs',
                  error ? 'bg-destructive/10 text-destructive' : 'bg-muted/40 text-muted-foreground',
                )}
              >
                {error ?? notice}
              </div>
            )}

            <div className="border-t border-border p-3">
              <div className="flex items-end gap-2">
                <Textarea
                  rows={2}
                  value={draft}
                  placeholder={t('composer.placeholder')}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // IME 组合输入中的回车不发送
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void submitMain();
                    }
                  }}
                  className="min-h-[56px] flex-1 resize-none text-sm"
                />
                <DsButton onClick={() => void submitMain()} disabled={!draft.trim() || sending}>
                  {t('composer.send')}
                </DsButton>
              </div>
              <p className="mt-1.5 text-2xs text-muted-foreground">{t('composer.hint')}</p>
            </div>
          </>
        )}
      </div>

      {/* 任务面板 */}
      {enabled && (
        <aside className="hidden w-72 shrink-0 flex-col border-l border-border md:flex">
          <div className="flex items-center justify-between px-3 py-2.5">
            <h2 className="text-sm font-medium">{t('tasks.title')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('tasks.running', { running: status?.stats.workersRunning ?? 0, total: workers.length })}
            </span>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
            {workers.length === 0 ? (
              <p className="px-1 pt-4 text-xs text-muted-foreground">{t('tasks.empty')}</p>
            ) : (
              workers.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  onClose={(id) => void closeWorker(id)}
                  onRevive={(id) => void reviveWorker(id)}
                  onSend={handleSend}
                />
              ))
            )}
          </div>
        </aside>
      )}
    </div>
  );
};

export default SuperAgentPage;
