/**
 * 翻译查看器包装组件
 *
 * 将翻译结果显示包装为符合 DSTU EditorProps 接口的组件。
 *
 * 数据契约：
 * - 正文来自 dstu.getContent（VFS resources.data），通过
 *   parseTranslationContent 解析，兼容 v2 {source, translated, meta}、
 *   v1 {source, translated}、历史 camelCase/snake_case 变体与纯文本；
 * - 语向/正式度/领域/术语表等会话设置优先取正文 meta（SSOT），
 *   缺失时回退 dstu.get 节点 metadata。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  ArrowRight,
  Check,
  CircleNotch,
  Copy,
  Heart,
  Star,
  Translate,
  WarningCircle,
} from '@phosphor-icons/react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { dstu } from '../api';
import {
  parseTranslationContent,
  type TranslationContentMeta,
} from '../adapters/translationDstuAdapter';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { IconSwap } from '@/components/ui/IconSwap';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型
// ============================================================================

interface ViewerData {
  title: string | null;
  source: string;
  translated: string;
  srcLang?: string;
  tgtLang?: string;
  formality?: TranslationContentMeta['formality'];
  domain?: string;
  glossaryCount: number;
  quality?: number;
  isFavorite: boolean;
}

type ViewerState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ViewerData };

type ViewMode = 'stacked' | 'interleaved';

// ============================================================================
// 工具
// ============================================================================

/** 旧语言码 normalize（与 adapter 保持一致的展示层兜底） */
function normalizeLang(code?: string): string | undefined {
  if (!code) return undefined;
  return code === 'zh' ? 'zh-CN' : code;
}

/** 按行拆段（空段丢弃），用于逐段对照 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
}

// ============================================================================
// 复制图标按钮：复制成功后 Copy → Check 交叉切换，2 秒后还原
// ============================================================================

const CopyIconButton: React.FC<{ text: string; label: string; copiedLabel: string }> = ({
  text,
  label,
  copiedLabel,
}) => {
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
      console.error('[TranslationViewer] Copy failed:', error);
    }
  }, [text]);

  return (
    <NotionButton
      variant="ghost"
      size="icon"
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      disabled={!text}
      onClick={() => void handleCopy()}
      className={copied ? 'text-success hover:text-success' : undefined}
    >
      <IconSwap
        active={copied}
        a={<Copy size={14} aria-hidden="true" />}
        b={<Check size={14} aria-hidden="true" />}
      />
    </NotionButton>
  );
};

// ============================================================================
// 元信息 chip
// ============================================================================

const MetaChip: React.FC<{ children: React.ReactNode; title?: string }> = ({ children, title }) => (
  <span
    title={title}
    className="inline-flex items-center gap-1 rounded-full border border-border/50 bg-background px-2 py-0.5 text-xs text-muted-foreground"
  >
    {children}
  </span>
);

// ============================================================================
// 主组件
// ============================================================================

/**
 * 翻译查看器包装组件
 *
 * 通过 DSTU API 加载翻译数据（正文 + 节点元数据），只读展示。
 */
export const TranslationViewerWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'translation', 'common']);
  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const [viewMode, setViewMode] = useState<ViewMode>('stacked');
  // 丢弃过期请求：path 变化或重试后，旧请求结果不再写入状态
  const requestIdRef = useRef(0);

  // 判断是否为创建模式（翻译不支持创建模式）
  const isCreateMode = 'mode' in props && props.mode === 'create';
  const path = !isCreateMode && 'path' in props ? props.path : null;
  const onClose = 'onClose' in props ? props.onClose : undefined;

  // 加载翻译数据：正文（SSOT）与节点元数据并行获取
  const loadTranslation = useCallback(async () => {
    if (isCreateMode) {
      setState({ status: 'error', message: t('dstu:errors.internal') });
      return;
    }
    if (!path) return;

    const requestId = ++requestIdRef.current;
    const isStale = () => requestIdRef.current !== requestId;

    setState({ status: 'loading' });

    const [contentResult, nodeResult] = await Promise.all([
      dstu.getContent(path),
      dstu.get(path),
    ]);
    if (isStale()) return;

    if (!contentResult.ok) {
      const errMsg = contentResult.error.toUserMessage();
      setState({ status: 'error', message: errMsg });
      showGlobalNotification('error', errMsg);
      return;
    }
    if (typeof contentResult.value !== 'string') {
      setState({ status: 'error', message: t('translation:viewer.non_text_content') });
      return;
    }

    const parsed = parseTranslationContent(contentResult.value);
    const nodeMeta = nodeResult.ok ? (nodeResult.value.metadata ?? {}) : {};

    // 正文 meta 优先，节点 metadata 兜底
    const glossary = parsed.meta?.glossary
      ?? (Array.isArray(nodeMeta.glossary) ? (nodeMeta.glossary as unknown[]) : undefined);

    setState({
      status: 'ready',
      data: {
        title: nodeResult.ok ? nodeResult.value.name : null,
        source: parsed.source,
        translated: parsed.translated,
        srcLang: normalizeLang(parsed.meta?.srcLang ?? (nodeMeta.srcLang as string | undefined)),
        tgtLang: normalizeLang(parsed.meta?.tgtLang ?? (nodeMeta.tgtLang as string | undefined)),
        formality: parsed.meta?.formality
          ?? (nodeMeta.formality as TranslationContentMeta['formality'] | undefined),
        domain: parsed.meta?.domain ?? (nodeMeta.domain as string | undefined),
        glossaryCount: glossary?.length ?? 0,
        quality: typeof nodeMeta.qualityRating === 'number' ? nodeMeta.qualityRating : undefined,
        isFavorite: Boolean(nodeMeta.isFavorite),
      },
    });
  }, [isCreateMode, path, t]);

  useEffect(() => {
    void loadTranslation();
  }, [loadTranslation]);

  // 语言展示名：languages 表命中用本地化名，否则显示原始代码
  const langLabel = useCallback(
    (code?: string): string => {
      if (!code) return t('translation:viewer.unknown_lang');
      if (code === 'auto') return t('translation:languages.auto');
      return t(`translation:languages.${code}`, { defaultValue: code });
    },
    [t]
  );

  const data = state.status === 'ready' ? state.data : null;

  // 逐段对照的段落配对（源段 + 译段交替）
  const paragraphPairs = useMemo(() => {
    if (!data) return [];
    const sourceParas = splitParagraphs(data.source);
    const translatedParas = splitParagraphs(data.translated);
    const length = Math.max(sourceParas.length, translatedParas.length);
    return Array.from({ length }, (_, i) => ({
      source: sourceParas[i] ?? '',
      translated: translatedParas[i] ?? '',
    }));
  }, [data]);

  const canInterleave = !!data && !!data.source && !!data.translated;

  // 加载状态
  if (state.status === 'loading') {
    return (
      <div
        className={cn('flex items-center justify-center h-full py-8 gap-2 ui-fade-in', props.className)}
        role="status"
      >
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span className="text-sm text-muted-foreground">{t('translation:viewer.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (state.status === 'error') {
    return (
      <div
        className={cn('flex flex-col items-center justify-center h-full py-8 gap-4 ui-fade-in', props.className)}
        role="alert"
      >
        <div className="flex items-center justify-center w-14 h-14 rounded-full bg-destructive/10">
          <WarningCircle size={28} className="text-destructive" aria-hidden="true" />
        </div>
        <p className="text-sm text-destructive text-center max-w-md px-4">{state.message}</p>
        <div className="flex gap-2">
          <NotionButton variant="primary" size="sm" onClick={() => void loadTranslation()}>
            <ArrowClockwise size={14} aria-hidden="true" />
            {t('common:actions.retry')}
          </NotionButton>
          {onClose && (
            <NotionButton variant="ghost" size="sm" onClick={onClose}>
              {t('common:actions.close')}
            </NotionButton>
          )}
        </div>
      </div>
    );
  }

  if (!data) return null;

  const isEmpty = !data.source && !data.translated;

  const sections = [
    {
      key: 'source',
      label: t('translation:source'),
      text: data.source,
      copyLabel: t('translation:popover.copy_source'),
      boxClassName: 'bg-muted/10 border-border/50',
    },
    {
      key: 'translated',
      label: t('translation:translated'),
      text: data.translated,
      copyLabel: t('translation:popover.copy_translation'),
      boxClassName: 'bg-primary/5 border-primary/15',
    },
  ];

  // 翻译查看器 UI
  return (
    <div className={cn('flex flex-col h-full bg-background ui-fade-in', props.className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 flex items-center gap-2 h-12 px-3 sm:px-4 border-b border-border/50">
        <Translate size={18} className="text-muted-foreground shrink-0" aria-hidden="true" />
        <span className="text-sm font-medium truncate" title={data.title ?? undefined}>
          {data.title || t('dstu:types.translation')}
        </span>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {!isEmpty && (
            <SegmentedControl<ViewMode>
              ariaLabel={t('translation:viewer.view_mode')}
              size="compact"
              value={viewMode}
              onValueChange={setViewMode}
              options={[
                { value: 'stacked', label: t('translation:viewer.view_stacked') },
                {
                  value: 'interleaved',
                  label: t('translation:viewer.view_interleaved'),
                  disabled: !canInterleave,
                },
              ]}
            />
          )}
          {onClose && (
            <NotionButton variant="ghost" size="sm" onClick={onClose}>
              {t('common:actions.close')}
            </NotionButton>
          )}
        </div>
      </div>

      {/* 元信息内联展示条：语向 / 正式度 / 领域 / 术语表 / 评分 / 收藏 */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-1.5 px-3 sm:px-4 py-2 border-b border-border/50 bg-muted/10">
        <MetaChip title={t('translation:languages.source_lang')}>
          {langLabel(data.srcLang)}
          <ArrowRight size={10} aria-hidden="true" />
          {langLabel(data.tgtLang)}
        </MetaChip>
        {data.formality && data.formality !== 'auto' && (
          <MetaChip title={t('translation:prompt_editor.formality')}>
            {t(`translation:prompt_editor.formality_${data.formality}`)}
          </MetaChip>
        )}
        {data.domain && data.domain !== 'general' && (
          <MetaChip title={t('translation:prompt_editor.domain')}>
            {t(`translation:prompt_editor.domain_${data.domain}`, { defaultValue: data.domain })}
          </MetaChip>
        )}
        {data.glossaryCount > 0 && (
          <MetaChip title={t('translation:prompt_editor.glossary_title')}>
            {t('translation:viewer.meta_glossary', { n: data.glossaryCount })}
          </MetaChip>
        )}
        {typeof data.quality === 'number' && (
          <MetaChip title={t('translation:quality.title')}>
            <Star size={12} weight="fill" className="text-warning" aria-hidden="true" />
            {t('translation:viewer.meta_quality', { n: data.quality })}
          </MetaChip>
        )}
        {data.isFavorite && (
          <MetaChip>
            <Heart size={12} weight="fill" className="text-destructive" aria-hidden="true" />
            {t('translation:viewer.meta_favorite')}
          </MetaChip>
        )}
      </div>

      {/* 翻译内容 */}
      <CustomScrollArea className="flex-1" viewportClassName="p-3 sm:p-4">
        {isEmpty ? (
          // 空态：无原文也无译文
          <div className="flex flex-col items-center justify-center h-full min-h-[12rem] gap-3 py-8">
            <div className="flex items-center justify-center w-16 h-16 rounded-full bg-muted/40">
              <Translate size={28} className="text-muted-foreground" aria-hidden="true" />
            </div>
            <p className="text-sm font-medium text-foreground">
              {t('translation:viewer.empty_title')}
            </p>
            <p className="text-xs text-muted-foreground text-center max-w-sm">
              {t('translation:viewer.empty_hint')}
            </p>
          </div>
        ) : viewMode === 'interleaved' && canInterleave ? (
          // 逐段对照：源段 + 译段交替
          <div className="space-y-1" role="list">
            {paragraphPairs.map((pair, index) => (
              <div
                key={index}
                role="listitem"
                className="rounded-md px-3 py-2 space-y-1 transition-colors duration-150 hover:bg-[var(--interactive-hover)]"
              >
                <p className="text-sm leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                  {pair.source}
                </p>
                {pair.translated ? (
                  <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                    {pair.translated}
                  </p>
                ) : (
                  <p className="text-sm leading-relaxed text-muted-foreground/60 italic">
                    {t('translation:panel_ux.pending_segment')}
                  </p>
                )}
              </div>
            ))}
          </div>
        ) : (
          // 分节视图：原文 / 译文 分块（带字数与复制）
          <div className="space-y-3">
            {sections.map(section => (
              <section
                key={section.key}
                className={cn('rounded-lg border overflow-hidden', section.boxClassName)}
              >
                <header className="flex items-center gap-2 px-3 py-2 border-b border-border/40">
                  <h3 className="text-sm font-medium text-foreground">{section.label}</h3>
                  <span className="text-xs text-muted-foreground">
                    {t('translation:viewer.char_count', { n: section.text.length })}
                  </span>
                  <div className="ml-auto">
                    <CopyIconButton
                      text={section.text}
                      label={section.copyLabel}
                      copiedLabel={t('translation:popover.copied')}
                    />
                  </div>
                </header>
                <div className="p-3">
                  {section.text ? (
                    <p className="text-sm leading-relaxed whitespace-pre-wrap break-words text-foreground">
                      {section.text}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground/70 italic">
                      {t('translation:panel_ux.pending_segment')}
                    </p>
                  )}
                </div>
              </section>
            ))}
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default TranslationViewerWrapper;
