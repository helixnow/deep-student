import '@/styles/tailwind.css';
import '@/styles/shadcn-variables.css';
import './quick-assistant.css';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Brain,
  CaretLeft,
  Check,
  ClipboardText,
  CopySimple,
  FileMagnifyingGlass,
  Lightbulb,
  MagnifyingGlass,
  NotePencil,
  PushPin,
  PushPinSlash,
  Sparkle,
  SpinnerGap,
  Stack,
  Student,
  Translate,
  X,
} from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import useTheme from '@/hooks/useTheme';
import { initializeFontSetting } from '@/hooks/useAppInitialization';
import { cn } from '@/lib/utils';
import {
  getQuickAssistantConfig,
  readQuickAssistantPinned,
  saveQuickAssistantPinned,
} from './config';
import {
  getActiveTodoSummary,
  getQuickReviewCard,
  inferQuickActions,
  isCaptureLikeText,
  performImageOcr,
  rateQuickReviewCard,
  saveAsCard,
  saveAsMistake,
  saveAsNote,
  saveAsTodo,
  searchLearningHistory,
  startQuickLearningAction,
  type QuickLearningAction,
  type QuickRunHandle,
  type QuickSearchResult,
} from './service';
import {
  QUICK_ASSISTANT_SHOWN_EVENT,
  hideCurrentQuickAssistantWindow,
  openQuickAssistantTarget,
} from './window';

type Route = 'home' | 'answer' | 'search' | 'review' | 'status';
type SaveKind = 'note' | 'mistake' | 'card' | 'todo';

const ACTION_META: Record<QuickLearningAction, { label: string; hint: string; icon: Icon }> = {
  ask: { label: '直接提问', hint: '先结论，再解释', icon: Sparkle },
  explain: { label: '讲明白', hint: '概念、关系和例子', icon: Brain },
  translate: { label: '翻译', hint: '保留术语与公式', icon: Translate },
  summarize: { label: '提炼要点', hint: '主旨 + 要点 + 关键词', icon: Stack },
  hint: { label: '只给提示', hint: '不给答案，给考点和思路', icon: Lightbulb },
};

type HomeItem =
  | { kind: 'llm'; action: QuickLearningAction }
  | { kind: 'search' }
  | { kind: 'review' }
  | { kind: 'status' };

const FEATURE_META: Record<'search' | 'review' | 'status', { label: string; hint: string; icon: Icon }> = {
  search: { label: '找回学习记录', hint: '笔记、教材、错题、历史会话', icon: MagnifyingGlass },
  review: { label: '速刷到期卡片', hint: '顺手复习一张', icon: Student },
  status: { label: '今日学习状态', hint: '待办与复习进度', icon: Stack },
};

function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
    reader.readAsDataURL(file);
  });
}

function stripSnippetHtml(value: string): string {
  return value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function isImeEvent(event: KeyboardEvent | React.KeyboardEvent): boolean {
  const native = 'nativeEvent' in event ? event.nativeEvent : event;
  return native.isComposing || event.key === 'Process';
}

export const QuickAssistantWindow: React.FC = () => {
  useTheme();
  const [route, setRoute] = useState<Route>('home');
  const [input, setInput] = useState('');
  const [capture, setCapture] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [answer, setAnswer] = useState('');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [currentAction, setCurrentAction] = useState<QuickLearningAction>('ask');
  const [askedContent, setAskedContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  const [searchResults, setSearchResults] = useState<QuickSearchResult[]>([]);
  const [reviewCard, setReviewCard] = useState<Awaited<ReturnType<typeof getQuickReviewCard>>>(null);
  const [reviewRevealed, setReviewRevealed] = useState(false);
  const [reviewStartedAt, setReviewStartedAt] = useState(Date.now());
  const [todoSummary, setTodoSummary] = useState<Awaited<ReturnType<typeof getActiveTodoSummary>>>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const lastShownAtRef = useRef(Date.now());
  const lastClipboardRef = useRef<string | null>(null);
  const runRef = useRef<QuickRunHandle | null>(null);

  /** 捕获内容 + 用户补充提问，作为动作推断与执行的完整上下文。 */
  const content = useMemo(() => {
    const parts = [capture.trim(), input.trim()].filter(Boolean);
    return parts.join('\n\n');
  }, [capture, input]);

  const homeItems = useMemo<HomeItem[]>(() => [
    ...inferQuickActions(content).map((action) => ({ kind: 'llm' as const, action })),
    { kind: 'search' },
    { kind: 'review' },
    { kind: 'status' },
  ], [content]);

  const focusInput = useCallback(() => {
    window.setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const loadClipboard = useCallback(async () => {
    const config = await getQuickAssistantConfig();
    if (!config.readClipboard) return;
    try {
      const value = (await readText()).trim();
      if (value && value !== lastClipboardRef.current) {
        lastClipboardRef.current = value;
        setCapture(value.slice(0, 20_000));
        setSelectedIndex(0);
      }
    } catch {
      // Clipboard permission may be unavailable on first launch.
    }
  }, []);

  const clearCapture = useCallback(() => {
    setCapture('');
    setSelectedIndex(0);
    focusInput();
  }, [focusInput]);

  const goHome = useCallback(() => {
    setRoute('home');
    setAnswer('');
    setSessionId(null);
    setAskedContent('');
    setMessage(null);
    setSearchResults([]);
    setReviewRevealed(false);
    setSelectedIndex(0);
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    void readQuickAssistantPinned().then(setPinned);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen(QUICK_ASSISTANT_SHOWN_EVENT, () => {
      lastShownAtRef.current = Date.now();
      setMessage(null);
      // 窗口常驻复用：每次呼出时重读全局字体/字号，同步主窗口里的最新设置
      void initializeFontSetting();
      void loadClipboard();
      focusInput();
    }).then((fn) => { unlisten = fn; });
    void loadClipboard();
    focusInput();
    return () => unlisten?.();
  }, [loadClipboard, focusInput]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void getCurrentWindow().onFocusChanged(({ payload }) => {
      const focusSettled = Date.now() - lastShownAtRef.current > 350;
      if (!payload && focusSettled && !pinned && !busy) void hideCurrentQuickAssistantWindow();
    }).then((fn) => { unlisten = fn; });
    return () => unlisten?.();
  }, [pinned, busy]);

  const handleAction = useCallback(async (action: QuickLearningAction) => {
    if (busy) return;
    if (!content) {
      setMessage('先输入或粘贴要学习的内容');
      focusInput();
      return;
    }
    setBusy(true);
    setAnswer('');
    setSessionId(null);
    setCurrentAction(action);
    setAskedContent(content);
    setRoute('answer');
    setMessage(`${ACTION_META[action].label}中…`);
    try {
      const handle = await startQuickLearningAction(content, action, setAnswer);
      runRef.current = handle;
      setSessionId(handle.sessionId);
      const result = await handle.completion;
      setAnswer(result.answer);
      setMessage('完成 · 可沉淀到学习系统');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      runRef.current = null;
      setBusy(false);
    }
  }, [busy, content, focusInput]);

  const runSearch = useCallback(async (query: string) => {
    if (query.trim().length < 2 || busy) return;
    setBusy(true);
    setMessage('正在查找你的学习内容…');
    try {
      const results = await searchLearningHistory(query);
      setSearchResults(results);
      setMessage(results.length ? `找到 ${results.length} 项` : '没有找到相关内容');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const openReview = useCallback(async () => {
    setRoute('review');
    setMessage(null);
    setBusy(true);
    try {
      setReviewCard(await getQuickReviewCard());
      setReviewRevealed(false);
      setReviewStartedAt(Date.now());
    } finally {
      setBusy(false);
    }
  }, []);

  const openStatus = useCallback(async () => {
    setRoute('status');
    setMessage(null);
    setBusy(true);
    try {
      setTodoSummary(await getActiveTodoSummary());
    } finally {
      setBusy(false);
    }
  }, []);

  const executeItem = useCallback((item: HomeItem) => {
    if (item.kind === 'llm') {
      void handleAction(item.action);
      return;
    }
    if (item.kind === 'search') {
      setRoute('search');
      setSearchResults([]);
      setMessage(null);
      focusInput();
      if (input.trim().length >= 2) void runSearch(input);
      return;
    }
    if (item.kind === 'review') void openReview();
    if (item.kind === 'status') void openStatus();
  }, [handleAction, focusInput, input, runSearch, openReview, openStatus]);

  const handleEscape = useCallback(() => {
    if (busy && runRef.current) {
      runRef.current.cancel();
      return;
    }
    if (route !== 'home') {
      goHome();
      return;
    }
    void hideCurrentQuickAssistantWindow();
  }, [busy, route, goHome]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isImeEvent(event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        handleEscape();
        return;
      }
      if (route === 'home') {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setSelectedIndex((value) => (value + 1) % homeItems.length);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          setSelectedIndex((value) => (value - 1 + homeItems.length) % homeItems.length);
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          executeItem(homeItems[selectedIndex] ?? homeItems[0]);
          return;
        }
        if (event.key === 'Backspace' && !input && capture) {
          event.preventDefault();
          clearCapture();
        }
        return;
      }
      if (route === 'search' && event.key === 'Enter') {
        event.preventDefault();
        void runSearch(input);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [route, homeItems, selectedIndex, input, capture, executeItem, handleEscape, clearCapture, runSearch]);

  const handlePaste = useCallback(async (event: React.ClipboardEvent<HTMLInputElement>) => {
    const image = Array.from(event.clipboardData.files).find((file) => file.type.startsWith('image/'));
    if (image) {
      event.preventDefault();
      setBusy(true);
      setMessage('正在识别图片…');
      try {
        const dataUrl = await imageFileToDataUrl(image);
        const text = await performImageOcr(dataUrl);
        if (text) {
          setCapture(text);
          lastClipboardRef.current = text;
        }
        setMessage(text ? '截图内容已捕获' : '未识别到文字');
      } catch (error) {
        setMessage(String(error));
      } finally {
        setBusy(false);
      }
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (route === 'home' && isCaptureLikeText(text)) {
      // 学习材料进捕获区，输入框留给用户自己的问题。
      event.preventDefault();
      setCapture(text.trim().slice(0, 20_000));
      lastClipboardRef.current = text.trim();
      setSelectedIndex(0);
    }
  }, [route]);

  const handleSave = useCallback(async (kind: SaveKind) => {
    const source = askedContent || content;
    if (!source || busy) return;
    const labels: Record<SaveKind, string> = { note: '笔记', mistake: '错题', card: '卡片', todo: '待办' };
    setBusy(true);
    setMessage(`正在保存为${labels[kind]}…`);
    try {
      if (kind === 'note') await saveAsNote(source, answer);
      if (kind === 'mistake') await saveAsMistake(source, answer);
      if (kind === 'card') await saveAsCard(source, answer);
      if (kind === 'todo') await saveAsTodo(source, answer);
      setMessage(`已保存为${labels[kind]}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [askedContent, content, answer, busy]);

  const handleCopyAnswer = useCallback(async () => {
    if (!answer) return;
    try {
      await writeText(answer);
      lastClipboardRef.current = answer;
      setMessage('回答已复制');
    } catch {
      setMessage('复制失败');
    }
  }, [answer]);

  const togglePinned = useCallback(() => {
    setPinned((value) => {
      void saveQuickAssistantPinned(!value);
      return !value;
    });
  }, []);

  const rateCard = useCallback(async (rating: number) => {
    if (!reviewCard) return;
    setBusy(true);
    try {
      await rateQuickReviewCard(reviewCard.id, rating, Date.now() - reviewStartedAt);
      setReviewCard(await getQuickReviewCard());
      setReviewRevealed(false);
      setReviewStartedAt(Date.now());
      setMessage('复习进度已更新');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [reviewCard, reviewStartedAt]);

  const footerHint = useMemo(() => {
    if (message) return message;
    if (route === 'home') return '↑↓ 选择 · Enter 执行 · Esc 隐藏';
    if (route === 'answer' && busy) return 'Esc 停止生成';
    return 'Esc 返回';
  }, [message, route, busy]);

  const backButton = (
    <button className="qa-back" onClick={goHome}>
      <CaretLeft size={14} />返回
    </button>
  );

  return (
    <main className="qa-shell">
      <header className="qa-titlebar" data-tauri-drag-region>
        <div className="qa-brand" data-tauri-drag-region>
          <span className="qa-brand-mark"><Brain size={17} weight="fill" /></span>
          <span data-tauri-drag-region>快速学习</span>
        </div>
        <div className="qa-window-actions">
          <button className={cn('qa-icon-button', pinned && 'is-active')} onClick={togglePinned} title={pinned ? '取消固定' : '固定窗口'}>
            {pinned ? <PushPinSlash size={15} /> : <PushPin size={15} />}
          </button>
          <button className="qa-icon-button" onClick={() => void hideCurrentQuickAssistantWindow()} title="隐藏"><X size={16} /></button>
        </div>
      </header>

      {route === 'home' && (
        <section className="qa-content qa-home">
          <div className="qa-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => { setInput(event.target.value); setSelectedIndex(0); }}
              onPaste={(event) => void handlePaste(event)}
              placeholder={capture ? '补充你的问题，或直接选择动作…' : '粘贴题目、概念、外文或截图，开始学习…'}
              className="qa-input"
              spellCheck={false}
            />
          </div>

          {capture && (
            <div className="qa-capture-chip">
              <span className="qa-capture-icon"><ClipboardText size={14} /></span>
              <span className="qa-capture-text">{capture}</span>
              <span className="qa-capture-count">{capture.length.toLocaleString()} 字</span>
              <button className="qa-capture-clear" onClick={clearCapture} title="清除捕获内容（输入框为空时按 Backspace 同样清除）">
                <X size={13} />
              </button>
            </div>
          )}

          <div className="qa-menu" role="listbox" aria-label="学习动作">
            {homeItems.map((item, index) => {
              const meta = item.kind === 'llm' ? ACTION_META[item.action] : FEATURE_META[item.kind];
              const IconComponent = meta.icon;
              const key = item.kind === 'llm' ? `llm-${item.action}` : item.kind;
              const disabled = item.kind === 'llm' && !content;
              return (
                <React.Fragment key={key}>
                  {index === 3 && <div className="qa-menu-divider" />}
                  <button
                    className={cn('qa-menu-item', index === selectedIndex && 'is-active', disabled && 'is-dim')}
                    role="option"
                    aria-selected={index === selectedIndex}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => executeItem(item)}
                  >
                    <span className="qa-menu-icon"><IconComponent size={16} /></span>
                    <span className="qa-menu-copy">
                      <strong>{meta.label}</strong>
                      <small>{meta.hint}</small>
                    </span>
                    {item.kind === 'llm' && index === 0 && <span className="qa-menu-badge">推荐</span>}
                    {index === selectedIndex && <span className="qa-menu-enter">↵</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </section>
      )}

      {route === 'answer' && (
        <section className="qa-content qa-answer-view">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">{ACTION_META[currentAction].label}</span>
            <button className="qa-icon-button" onClick={() => void handleCopyAnswer()} disabled={!answer} title="复制回答">
              <CopySimple size={15} />
            </button>
          </div>
          {askedContent && <div className="qa-asked">{askedContent}</div>}
          <article className="qa-answer" aria-live="polite">
            {answer
              ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
              : <div className="qa-loading"><SpinnerGap size={17} className="qa-spin" />正在思考当前学习内容</div>}
          </article>
          {answer && !busy && (
            <div className="qa-save-row">
              <span>沉淀到</span>
              <button onClick={() => void handleSave('note')}><NotePencil size={14} />笔记</button>
              <button onClick={() => void handleSave('mistake')}><FileMagnifyingGlass size={14} />错题</button>
              <button onClick={() => void handleSave('card')}><Stack size={14} />卡片</button>
              <button onClick={() => void handleSave('todo')}><Check size={14} />待办</button>
              {sessionId && <button className="qa-continue" onClick={() => void openQuickAssistantTarget({ kind: 'session', id: sessionId })}>主窗口继续<ArrowRight size={14} /></button>}
            </div>
          )}
        </section>
      )}

      {route === 'search' && (
        <section className="qa-content qa-search-view">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">找回学习记录</span>
          </div>
          <div className="qa-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="搜索笔记、教材、错题和历史会话…"
              className="qa-input"
              spellCheck={false}
            />
          </div>
          <div className="qa-results">
            {searchResults.map((result) => (
              <button key={`${result.kind}-${result.id}`} className="qa-result" onClick={() => void openQuickAssistantTarget({ kind: result.kind === 'resource' ? 'resource' : 'session', id: result.id })}>
                <span className="qa-result-icon">{result.kind === 'resource' ? <NotePencil size={16} /> : <Brain size={16} />}</span>
                <span className="qa-result-copy"><strong>{result.title}</strong><small>{stripSnippetHtml(result.snippet)}</small></span>
                <ArrowRight size={15} />
              </button>
            ))}
            {!searchResults.length && !busy && (
              <div className="qa-empty"><MagnifyingGlass size={22} /><span>输入至少 2 个字，回车开始搜索</span></div>
            )}
          </div>
        </section>
      )}

      {route === 'review' && (
        <section className="qa-content qa-review">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">速刷到期卡片</span>
          </div>
          {busy ? <div className="qa-empty"><SpinnerGap size={22} className="qa-spin" />正在准备复习</div> : reviewCard ? (
            <>
              <div className="qa-review-front">{reviewCard.front || reviewCard.text || '未命名卡片'}</div>
              {reviewRevealed ? (
                <>
                  <div className="qa-review-back">{reviewCard.back || '暂无答案'}</div>
                  <div className="qa-rating-row">
                    <button onClick={() => void rateCard(1)}>重来</button><button onClick={() => void rateCard(2)}>困难</button><button onClick={() => void rateCard(3)}>记得</button><button onClick={() => void rateCard(4)}>简单</button>
                  </div>
                </>
              ) : <button className="qa-primary-button" onClick={() => setReviewRevealed(true)}>显示答案</button>}
            </>
          ) : <div className="qa-empty"><Check size={28} weight="bold" /><strong>今天的到期卡片已完成</strong><span>回到主应用可以开始新的学习任务</span></div>}
        </section>
      )}

      {route === 'status' && (
        <section className="qa-content qa-status">
          <div className="qa-subhead">
            {backButton}
            <span className="qa-subhead-title">今日学习状态</span>
          </div>
          <div className="qa-status-grid">
            <div><span>待处理</span><strong>{todoSummary?.stats.totalPending ?? 0}</strong></div>
            <div><span>今日到期</span><strong>{todoSummary?.stats.todayDue ?? 0}</strong></div>
            <div><span>已逾期</span><strong>{todoSummary?.stats.overdueCount ?? 0}</strong></div>
            <div><span>今日完成</span><strong>{todoSummary?.stats.todayCompleted ?? 0}</strong></div>
          </div>
          <div className="qa-status-list">
            {[...(todoSummary?.overdueItems ?? []), ...(todoSummary?.todayItems ?? [])].slice(0, 5).map((item) => <div key={item.id}><span>{item.title}</span><small>{item.listTitle}</small></div>)}
          </div>
          <button className="qa-primary-button" onClick={() => void openQuickAssistantTarget({ kind: 'view', view: 'todo' })}>打开学习计划<ArrowRight size={15} /></button>
        </section>
      )}

      <footer className="qa-footer">
        <span className={cn(message?.includes('失败') && 'is-error')}>{busy && <SpinnerGap size={12} className="qa-spin" />}{footerHint}</span>
      </footer>
    </main>
  );
};

export default QuickAssistantWindow;
