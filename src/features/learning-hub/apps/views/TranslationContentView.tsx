/**
 * TranslationContentView - 翻译内容视图
 *
 * 统一应用面板中的翻译视图。
 * 通过 DSTU 节点获取翻译会话数据，渲染翻译工作台。
 *
 * 新建流程已统一：先创建空文件 → 再打开加载 → 编辑保存
 * 不再需要 __create_new__ 特殊模式
 *
 * 视图层职责：
 * - 加载骨架（双栏结构预览）/ 加载失败错误态 + 重试
 * - 保存状态内联徽标（保存中 / 已保存 / 失败重试条），保存失败严格上抛，
 *   工作台不会误清 dirty 标记
 * - 工作台懒加载 chunk 失败 / 渲染崩溃时的内联降级：只读双语预览 + 复制 + 重新加载
 * - 新建空翻译的一次性内联引导条
 */

import React, { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Warning, Check, Copy, Info, X, ArrowClockwise } from '@phosphor-icons/react';
import type { ContentViewProps } from '../UnifiedAppPanel';
import {
  translationDstuAdapter,
  dstuNodeToTranslationSession,
  type TranslationSession,
} from '@/dstu/adapters/translationDstuAdapter';
import { getErrorMessage } from '@/utils/errorUtils';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { DsButton } from '@/components/ui/DsButton';
import { IconSwap } from '@/components/ui/IconSwap';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { reportFrontendError } from '@/logging/errorReporter';
import { registerContentAgentSurface } from '@/features/workbench/apps/content/contentAgentSurfaces';
import { normalizeResourceInstanceKey } from '@/features/workbench/apps/content/resourceIdentity';

/** 段落数：按空行/换行切分后剔除空白段（供 agent 观察投影） */
function countParagraphs(text: string): number {
  if (!text) return 0;
  return text.split(/\n+/).filter((line) => line.trim()).length;
}

// 懒加载翻译工作台。
// 工厂形式：React.lazy 会缓存失败的 import promise，chunk 加载失败后
// 重挂载同一个 lazy 组件仍会同步抛错，重试时需重建 lazy 实例
const createWorkbenchLazy = () =>
  lazy(() =>
    import('@/components/TranslateWorkbench').then(m => ({ default: m.TranslateWorkbench }))
  );

// 模块级共享实例：多个翻译标签页复用同一 chunk 请求
let sharedWorkbenchLazy = createWorkbenchLazy();

// ============================================================================
// 保存状态
// ============================================================================

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

// ============================================================================
// 加载骨架：模拟工具条 + 双栏（原文/译文）结构，避免整屏 spinner 的空白感
// ============================================================================

const TranslationSkeleton: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="flex flex-col h-full bg-background p-3 sm:p-4 gap-3 ui-fade-in"
    role="status"
    aria-label={label}
  >
    {/* 工具条骨架 */}
    <div className="flex items-center gap-2 h-12 shrink-0">
      <div className="h-7 w-28 rounded-control bg-muted animate-pulse" />
      <div className="h-7 w-7 rounded-control bg-muted animate-pulse" />
      <div className="h-7 w-28 rounded-control bg-muted animate-pulse" />
      <div className="ml-auto h-7 w-20 rounded-control bg-muted animate-pulse" />
    </div>
    {/* 双栏骨架：原文 / 译文 */}
    <div className="flex flex-col md:flex-row gap-3 flex-1 min-h-0">
      {[0, 1].map(panel => (
        <div
          key={panel}
          className="flex-1 min-h-[8rem] rounded-lg border border-border/50 bg-muted/10 p-4 space-y-3 overflow-hidden"
        >
          <div className="h-4 w-16 rounded-sm bg-muted animate-pulse" />
          <div className="h-3 w-full rounded-sm bg-muted animate-pulse" />
          <div className="h-3 w-5/6 rounded-sm bg-muted animate-pulse" />
          <div className="h-3 w-2/3 rounded-sm bg-muted animate-pulse" />
        </div>
      ))}
    </div>
    <span className="sr-only">{label}</span>
  </div>
);

// ============================================================================
// 复制按钮：复制成功后图标/文案交叉切换（IconSwap），2 秒后还原
// ============================================================================

const CopyButton: React.FC<{
  text: string;
  ariaLabel: string;
  copyLabel: string;
  copiedLabel: string;
}> = ({ text, ariaLabel, copyLabel, copiedLabel }) => {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch (error: unknown) {
      console.error('[TranslationContentView] Copy failed:', error);
    }
  }, [text]);

  // 说明：DsButton 基类含 [&_svg]:text-inherit 且 cn 非 tailwind-merge，
  // 同元素覆盖 text-* 不可靠，改在子 span 上着色（直接类优先于继承色）
  return (
    <DsButton
      variant="ghost"
      size="sm"
      aria-label={ariaLabel}
      disabled={!text}
      onClick={() => void handleCopy()}
      className="[@media(pointer:coarse)]:min-h-11"
    >
      <IconSwap
        active={copied}
        className={copied ? 'text-success' : undefined}
        a={<Copy size={14} aria-hidden="true" />}
        b={<Check size={14} aria-hidden="true" />}
      />
      <span className={copied ? 'text-success' : undefined}>
        {copied ? copiedLabel : copyLabel}
      </span>
    </DsButton>
  );
};

// ============================================================================
// 只读双语预览：工作台不可用时的降级展示（分区 + 字数 + 复制）
// ============================================================================

const BilingualPreview: React.FC<{ session: TranslationSession }> = ({ session }) => {
  const { t } = useTranslation(['translation']);

  const sections = [
    {
      key: 'source',
      title: t('translation:source'),
      text: session.sourceText,
      copyAria: t('translation:popover.copy_source'),
    },
    {
      key: 'translated',
      title: t('translation:translated'),
      text: session.translatedText,
      copyAria: t('translation:popover.copy_translation'),
    },
  ];

  return (
    <div className="grid gap-3 md:grid-cols-2">
      {sections.map(section => (
        <section
          key={section.key}
          className="flex flex-col min-w-0 rounded-lg border border-border/50 bg-muted/10 overflow-hidden"
        >
          {/* 📱 标题可截断、字数不换行：窄屏下防止头部被复制按钮挤压产生横向溢出 */}
          <header className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
            <h3 className="min-w-0 truncate text-sm font-medium text-foreground">{section.title}</h3>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {t('translation:contentView.char_count', { n: section.text.length })}
            </span>
            <div className="ml-auto shrink-0">
              <CopyButton
                text={section.text}
                ariaLabel={section.copyAria}
                copyLabel={t('translation:target_section.copy')}
                copiedLabel={t('translation:popover.copied')}
              />
            </div>
          </header>
          <CustomScrollArea className="max-h-72 min-h-0" fullHeight={false}>
            <div className="p-3">
              {section.text ? (
                <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
                  {section.text}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t('translation:contentView.empty_content')}
                </p>
              )}
            </div>
          </CustomScrollArea>
        </section>
      ))}
    </div>
  );
};

// ============================================================================
// 工作台错误边界：捕获懒加载 chunk 失败与工作台渲染崩溃，
// 降级为内联错误条 + 只读双语预览（不弹任何模态）
// ============================================================================

interface WorkbenchErrorBoundaryProps {
  fallback: React.ReactNode;
  children: React.ReactNode;
}

class WorkbenchErrorBoundary extends React.Component<
  WorkbenchErrorBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    console.error('[TranslationContentView] Workbench crashed:', error, info.componentStack);
    void reportFrontendError(error, {
      kind: 'REACT_ERROR_BOUNDARY',
      component: 'translation-workbench',
      extra: { componentStack: info.componentStack },
    }).catch(() => undefined);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

// ============================================================================
// 主组件
// ============================================================================

/**
 * 翻译内容视图
 */
const TranslationContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
  isActive,
  externalSettingsNavigation,
  externalSettingsOpen,
}) => {
  const { t } = useTranslation(['translation', 'common', 'learningHub']);

  // 翻译会话状态
  // 首帧同步初始化：metadata 已含完整内容时（重新打开已有翻译的常见场景）
  // 直接就绪，消除不必要的整屏 loading 闪烁
  const [session, setSession] = useState<TranslationSession | null>(() => {
    try {
      const converted = dstuNodeToTranslationSession(node);
      return converted.sourceText ? converted : null;
    } catch {
      return null;
    }
  });
  const [isLoading, setIsLoading] = useState(!session);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 保存状态（内联徽标 + 失败重试条）
  const [saveState, setSaveState] = useState<SaveState>({ status: 'idle' });
  // 最近一次保存失败的会话快照，供内联重试
  const pendingSaveRef = useRef<TranslationSession | null>(null);
  // 新建空翻译的引导条是否已被手动关闭
  const [emptyHintDismissed, setEmptyHintDismissed] = useState(false);

  // 工作台懒加载实例与重载纪元（chunk 失败/崩溃后重建 lazy + 重挂载边界）
  const [WorkbenchLazy, setWorkbenchLazy] = useState(() => sharedWorkbenchLazy);
  const [workbenchEpoch, setWorkbenchEpoch] = useState(0);
  const reloadWorkbench = useCallback(() => {
    sharedWorkbenchLazy = createWorkbenchLazy();
    setWorkbenchLazy(() => sharedWorkbenchLazy);
    setWorkbenchEpoch(v => v + 1);
  }, []);

  // 记录当前 node ID，用于丢弃切换节点后才完成的过期加载/保存
  const currentNodeIdRef = useRef<string>(node.id);
  // 已完成首次加载的节点 ID：同一节点的后续刷新静默进行，
  // 避免整屏 loading/错误屏卸载工作台导致用户输入丢失
  // （同步初始化成功时挂载即视为已加载）
  const loadedNodeIdRef = useRef<string | null>(session ? node.id : null);

  // 节点切换时在渲染阶段同步重置状态（React "adjusting state during render" 模式）：
  // 保证 key 切换后的工作台首帧即拿到正确的初始会话，不会闪现上一节点内容
  const [trackedNodeId, setTrackedNodeId] = useState(node.id);
  if (trackedNodeId !== node.id) {
    setTrackedNodeId(node.id);
    currentNodeIdRef.current = node.id;
    let next: TranslationSession | null = null;
    try {
      const converted = dstuNodeToTranslationSession(node);
      next = converted.sourceText ? converted : null;
    } catch {
      next = null;
    }
    // 无法同步就绪时清空"已加载"标记，让 loadSession 按首次加载处理
    // （出错进入错误屏，而非静默失败后渲染空会话工作台）
    loadedNodeIdRef.current = next ? node.id : null;
    setSession(next);
    setIsLoading(!next);
    setLoadError(null);
    // 保存状态与引导条均为节点级状态，切换后重置
    setSaveState({ status: 'idle' });
    pendingSaveRef.current = null;
    setEmptyHintDismissed(false);
  }

  // 加载翻译数据
  const loadSession = useCallback(async () => {
    // 捕获本次加载对应的 node ID：若加载期间切换了节点，丢弃过期结果，防止串数据
    const requestNodeId = node.id;
    const isStale = () => currentNodeIdRef.current !== requestNodeId;
    // 该节点是否已成功展示过：是则本次为静默刷新，
    // 不得进入整屏 loading/错误屏（会卸载工作台，丢失用户正在输入的内容）
    const isFirstLoad = loadedNodeIdRef.current !== requestNodeId;
    if (isFirstLoad) {
      setLoadError(null);
    }
    try {
      // 先尝试从 node.metadata 直接转换
      // 空文件的 metadata 包含默认空值，也能正确转换
      const converted = dstuNodeToTranslationSession(node);

      // 检查是否有实际内容（空文件的 sourceText 为空）
      if (converted.sourceText) {
        // 同步就绪，无需进入 loading。本地已有同节点更新的会话（如刚保存过）时
        // 保留本地版本，避免被父级传入的过期 metadata 回退
        setSession(prev =>
          prev && prev.id === converted.id && prev.updatedAt >= converted.updatedAt
            ? prev
            : converted
        );
        loadedNodeIdRef.current = requestNodeId;
      } else {
        // 需要异步获取时才进入 loading（仅首次；静默刷新保持工作台挂载）
        if (isFirstLoad) {
          setIsLoading(true);
        }
        // 尝试从 DSTU 获取完整数据
        const result = await translationDstuAdapter.getTranslation(node.id);
        if (isStale()) return;
        if (result.ok && result.value) {
          const fetched = dstuNodeToTranslationSession(result.value);
          // 与同步路径同规则：静默刷新拿到的旧数据不得回退刚保存的本地会话
          setSession(prev =>
            prev && prev.id === fetched.id && prev.updatedAt >= fetched.updatedAt
              ? prev
              : fetched
          );
          loadedNodeIdRef.current = requestNodeId;
        } else if (!result.ok) {
          // S-018 修复：加载失败时进入错误态，阻止保存操作，防止空内容覆盖真实数据
          const errMsg = 'error' in result ? getErrorMessage(result.error) : t('translation:errors.load_failed_generic');
          console.error('[TranslationContentView] Failed to load translation from DSTU:', errMsg);
          if (isFirstLoad) {
            setLoadError(errMsg);
            setSession(null);
          }
          return;
        } else {
          // 空文件：设置为带 node.id 的空会话
          setSession({
            ...converted,
            id: node.id,
          });
          loadedNodeIdRef.current = requestNodeId;
        }
      }
    } catch (error: unknown) {
      if (isStale()) return;
      // S-018 修复：加载异常时进入错误态，不设置空会话，防止空内容覆盖真实数据
      const errMsg = getErrorMessage(error);
      console.error('[TranslationContentView] Failed to load translation:', error);
      if (isFirstLoad) {
        setLoadError(errMsg);
        setSession(null);
      }
    } finally {
      if (!isStale()) {
        setIsLoading(false);
      }
    }
  }, [node, t]);

  useEffect(() => {
    currentNodeIdRef.current = node.id;
    void loadSession();
  }, [node, loadSession]);

  // 执行保存：检查 Result，失败时抛错（工作台据此保留 dirty 标记并提示），
  // 同时在视图层记录失败快照供内联重试
  const performSave = useCallback(async (sessionToSave: TranslationSession) => {
    const boundNodeId = sessionToSave.id;
    const isCurrent = () => currentNodeIdRef.current === boundNodeId;
    if (isCurrent()) {
      setSaveState({ status: 'saving' });
    }
    try {
      const result = await translationDstuAdapter.updateTranslation(sessionToSave);
      if (!result.ok) {
        // ★ 修复：保存失败不再静默成功。抛出后工作台不会调用
        // markTranslationPersisted，dirty 标记保留，本地视图也不做乐观更新
        throw result.error;
      }
      if (isCurrent()) {
        pendingSaveRef.current = null;
        setSession(sessionToSave);
        setSaveState({ status: 'saved' });
      }
    } catch (error: unknown) {
      console.error('[TranslationContentView] Failed to save translation:', error);
      if (isCurrent()) {
        pendingSaveRef.current = sessionToSave;
        setSaveState({ status: 'error', message: getErrorMessage(error) });
      }
      // 重新抛出，由工作台各调用点统一展示保存失败提示（避免双重 toast）
      throw error;
    }
  }, []);

  // 内联错误条重试：重放最近一次失败的保存
  const retrySave = useCallback(() => {
    const pending = pendingSaveRef.current;
    if (!pending || pending.id !== currentNodeIdRef.current) return;
    // 失败状态已由 performSave 写回，这里吞掉重抛避免 unhandled rejection
    void performSave(pending).catch(() => undefined);
  }, [performSave]);

  // 「已保存」徽标 2 秒后自动淡出
  useEffect(() => {
    if (saveState.status !== 'saved') return;
    const timer = window.setTimeout(() => {
      setSaveState(prev => (prev.status === 'saved' ? { status: 'idle' } : prev));
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [saveState.status]);

  // 稳定 dstuMode 引用：工作台多个 useCallback 依赖 dstuMode，
  // 每次渲染重建对象会导致其内部回调全部失效重建。
  // 保存回调绑定创建时的 node ID：切换节点后才完成的保存仍写回发起保存的节点
  // （不丢数据），但不再覆盖新节点的视图状态，也不会串写到新节点
  const dstuMode = useMemo(() => {
    const boundNodeId = node.id;
    return {
      session,
      // 已创建的空文件会有 ID，所以始终是更新操作
      onSessionSave: (updatedSession: TranslationSession) =>
        performSave({ ...updatedSession, id: boundNodeId }),
      resourceId: boundNodeId,
    };
  }, [session, node.id, performSave]);

  // ★ ACR 4.0（A7）：注册 agent 观察投影（源/译文字数与段落数、保存态）。
  //   滚动位置在懒加载工作台内部、无编程控制落点，故只提供观察不声明动作。
  const agentSurfaceStateRef = useRef({ session, isLoading, saveStatus: saveState.status });
  agentSurfaceStateRef.current = { session, isLoading, saveStatus: saveState.status };
  useEffect(() => {
    const resourceId = normalizeResourceInstanceKey(node.id);
    if (!resourceId) return undefined;
    return registerContentAgentSurface('translation', resourceId, {
      getSummary: () => {
        const s = agentSurfaceStateRef.current;
        return {
          ready: !s.isLoading && s.session != null,
          sourceChars: s.session?.sourceText.length ?? 0,
          translatedChars: s.session?.translatedText.length ?? 0,
          sourceParagraphs: countParagraphs(s.session?.sourceText ?? ''),
          translatedParagraphs: countParagraphs(s.session?.translatedText ?? ''),
          saveStatus: s.saveStatus,
        };
      },
    });
  }, [node.id]);

  // 加载中状态：双栏结构骨架
  if (isLoading) {
    return <TranslationSkeleton label={t('translation:contentView.skeleton_loading')} />;
  }

  // S-018 修复：加载失败时显示错误态，阻止用户在空表单上操作
  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-background gap-4 p-8 ui-fade-in" role="alert">
        <div className="flex items-center justify-center w-16 h-16 rounded-full bg-destructive/10">
          <Warning size={32} className="text-destructive" aria-hidden="true" />
        </div>
        <p className="text-sm text-destructive text-center max-w-md">
          {t('translation:errors.load_failed', { error: loadError })}
        </p>
        <div className="flex gap-2">
          <DsButton variant="primary" className="[@media(pointer:coarse)]:min-h-11" onClick={() => void loadSession()}>
            {t('common:retry')}
          </DsButton>
          {onClose && (
            <DsButton variant="ghost" className="[@media(pointer:coarse)]:min-h-11" onClick={onClose}>
              {t('common:back')}
            </DsButton>
          )}
        </div>
      </div>
    );
  }

  // 新建空翻译的一次性引导条（有内容或手动关闭后自然消失）
  const showEmptyHint =
    !!session && !session.sourceText && !session.translatedText && !emptyHintDismissed;

  const hasPreviewContent = !!session && !!(session.sourceText || session.translatedText);

  // 工作台不可用（chunk 加载失败 / 渲染崩溃）时的内联降级
  const workbenchFallback = (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background ui-fade-in" role="alert">
      {/* 📱 400px：操作按钮换行到文案下方（sm 以上保持右侧同排），避免标题被挤压截断 */}
      <div className="flex flex-wrap items-start gap-3 px-4 py-3 border-b border-destructive/20 bg-destructive/10">
        <Warning size={18} className="text-destructive shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0 flex-1 basis-48">
          <p className="text-sm font-medium text-destructive">
            {t('translation:contentView.workbench_error_title')}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {hasPreviewContent
              ? t('translation:contentView.workbench_error_desc')
              : t('translation:contentView.workbench_error_desc_empty')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 max-sm:w-full max-sm:justify-end">
          <DsButton variant="primary" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={reloadWorkbench}>
            <ArrowClockwise size={14} aria-hidden="true" />
            {t('translation:contentView.workbench_error_retry')}
          </DsButton>
          {onClose && (
            <DsButton variant="ghost" size="sm" className="[@media(pointer:coarse)]:min-h-11" onClick={onClose}>
              {t('common:back')}
            </DsButton>
          )}
        </div>
      </div>
      {hasPreviewContent && session && (
        <CustomScrollArea className="min-h-0 flex-1">
          <div className="p-3 sm:p-4">
            <BilingualPreview session={session} />
          </div>
        </CustomScrollArea>
      )}
    </div>
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* 保存失败内联错误条：保留 dirty 的同时提供就地重试 */}
      {!externalSettingsOpen && saveState.status === 'error' && (
        <div
          className="flex items-center gap-2 px-3 py-2 border-b border-destructive/20 bg-destructive/10 ui-slide-in-top"
          role="alert"
        >
          <Warning size={16} className="text-destructive shrink-0" aria-hidden="true" />
          {/* 📱 窄屏放宽为两行折行：title 悬停提示在触屏不可达，单行截断会丢失错误详情 */}
          <span
            className="min-w-0 flex-1 truncate text-sm text-destructive max-sm:whitespace-normal max-sm:line-clamp-2"
            title={saveState.message}
          >
            {t('translation:contentView.save_failed', { error: saveState.message })}
          </span>
          <DsButton
            variant="ghost"
            size="sm"
            className="shrink-0 [@media(pointer:coarse)]:min-h-11"
            onClick={retrySave}
          >
            {/* 着色放在子 span：直接类优先于按钮继承色，svg 再从 span 继承 */}
            <span className="inline-flex items-center gap-1.5 text-destructive">
              <ArrowClockwise size={14} aria-hidden="true" />
              {t('translation:contentView.save_retry')}
            </span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            className="shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            aria-label={t('translation:contentView.save_error_dismiss')}
            onClick={() => setSaveState({ status: 'idle' })}
          >
            <X size={14} aria-hidden="true" />
          </DsButton>
        </div>
      )}

      {/* 新建空翻译引导条 */}
      {!externalSettingsOpen && showEmptyHint && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 bg-muted/20 ui-slide-in-top">
          <Info size={14} className="text-info shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {t('translation:contentView.empty_hint')}
          </span>
          <DsButton
            variant="ghost"
            size="icon"
            className="shrink-0 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
            aria-label={t('translation:contentView.empty_hint_dismiss')}
            onClick={() => setEmptyHintDismissed(true)}
          >
            <X size={12} aria-hidden="true" />
          </DsButton>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        <WorkbenchErrorBoundary key={`${node.id}:${workbenchEpoch}`} fallback={workbenchFallback}>
          <Suspense
            fallback={<TranslationSkeleton label={t('translation:contentView.skeleton_loading')} />}
          >
            {/* key=node.id：切换节点时强制重挂载工作台（其内部状态仅在挂载时从 session 初始化） */}
            <WorkbenchLazy
              key={node.id}
              onBack={onClose}
              isActive={isActive}
              externalSettingsNavigation={externalSettingsNavigation}
              externalSettingsOpen={externalSettingsOpen}
              dstuMode={dstuMode}
            />
          </Suspense>
        </WorkbenchErrorBoundary>

        {/* 保存状态内联徽标（保存中 / 已保存），纯状态展示不拦截交互 */}
        {!externalSettingsOpen && (saveState.status === 'saving' || saveState.status === 'saved') && (
          <div
            className="pointer-events-none absolute bottom-4 right-4 z-10"
            role="status"
            aria-live="polite"
          >
            <span
              key={saveState.status}
              data-wb-blur-surface
              className="ui-rise-in inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-background/90 px-2.5 py-1 text-xs shadow-soft backdrop-blur-sm"
            >
              {saveState.status === 'saving' ? (
                <>
                  <CircleNotch size={12} className="animate-spin text-muted-foreground" aria-hidden="true" />
                  <span className="text-muted-foreground">
                    {t('translation:contentView.save_saving')}
                  </span>
                </>
              ) : (
                <>
                  <Check size={12} className="text-success" aria-hidden="true" />
                  <span className="text-success">
                    {t('translation:contentView.save_saved')}
                  </span>
                </>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default TranslationContentView;
