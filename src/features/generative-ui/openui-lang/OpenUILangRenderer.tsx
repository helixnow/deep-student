import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  Info,
  Minus,
  MinusCircle,
  TrendDown,
  TrendUp,
  Warning,
  WarningCircle,
} from '@phosphor-icons/react';
import { cn } from '@/utils/cn';
import {
  isOpenUIComponentNode,
  parseOpenUILang,
  type OpenUIComponentNode,
  type OpenUIValue,
} from './parser';
import {
  buildOnNotDrawnAutoHealResult,
  ensureAwaitAnswerSubmitButton,
  type OnNotDrawnAutoHealResult,
} from './multiCardDecisionAndHeal';

export interface OpenUILangAnswerData {
  button: string;
  value: string;
  values: Record<string, unknown>;
  note?: string;
}

export interface OpenUILangSubmitPayload {
  summary: string;
  data: OpenUILangAnswerData;
}

export interface OpenUILangRendererProps {
  source: string;
  isStreaming?: boolean;
  /** 是否处于等待用户拍板回答模式（自动展示备注框并在无按钮时补齐提交按钮） */
  awaitAnswer?: boolean;
  /** 已回答的数据快照（用于回显用户选择与锁定表单） */
  answer?: OpenUILangAnswerData | Record<string, unknown> | null;
  disabled?: boolean;
  onSubmit?: (payload: OpenUILangSubmitPayload) => void | Promise<void>;
  onNotDrawn?: (result: OnNotDrawnAutoHealResult) => void;
  className?: string;
}

type Tone = 'default' | 'info' | 'success' | 'warning' | 'error' | 'destructive';

const CHART_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--info))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(var(--muted-foreground))',
];

function normalizeTone(raw: unknown): Tone {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (s === 'success' || s === 'done' || s === 'up' || s === 'positive') return 'success';
  if (s === 'warning' || s === 'warn' || s === 'caution') return 'warning';
  if (s === 'error' || s === 'danger' || s === 'destructive' || s === 'down' || s === 'negative') {
    return 'error';
  }
  if (s === 'info' || s === 'active' || s === 'primary') return 'info';
  return 'default';
}

function toDisplayString(val: OpenUIValue): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (Array.isArray(val)) return val.map(toDisplayString).join(', ');
  if (isOpenUIComponentNode(val)) return val.name;
  try {
    return JSON.stringify(val);
  } catch {
    return String(val);
  }
}

/** Steps 状态同义词 → 规范状态（pending/active/done/error/skipped） */
function normalizeStepStatus(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'completed' || value === 'complete' || value === 'finished') return 'done';
  if (value === 'current' || value === 'in_progress' || value === 'in-progress' || value === 'running') {
    return 'active';
  }
  if (value === 'todo' || value === 'waiting' || value === 'queued') return 'pending';
  return value;
}

function isNumericLike(val: unknown): boolean {
  if (typeof val === 'number') return Number.isFinite(val);
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return /^[-+]?[$¥€£]?\d[\d,.]*%?$/.test(trimmed);
  }
  return false;
}

/**
 * 轻量内联 Markdown 渲染（支持 **粗体**、`代码`、[链接](url) 与换行列表，严格无 Emoji）
 */
function renderInlineMarkdown(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const regex = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2] !== undefined) {
      parts.push(
        <strong key={match.index} className="font-semibold text-foreground">
          {match[2]}
        </strong>,
      );
    } else if (match[3] !== undefined) {
      parts.push(
        <code
          key={match.index}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {match[3]}
        </code>,
      );
    } else if (match[4] !== undefined && match[5] !== undefined) {
      parts.push(
        <a
          key={match.index}
          href={match[5]}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-primary underline underline-offset-2"
        >
          {match[4]}
        </a>,
      );
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length === 1 ? parts[0] : parts;
}

function renderMarkdownBlocks(markdown: string): React.ReactNode {
  const lines = markdown.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let listItems: string[] = [];

  const flushList = (keyPrefix: number) => {
    if (listItems.length === 0) return;
    elements.push(
      <ul key={`list-${keyPrefix}`} className="list-disc space-y-1 pl-5 text-sm text-foreground/90">
        {listItems.map((item, idx) => (
          <li key={idx}>{renderInlineMarkdown(item)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) {
      flushList(idx);
      return;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      listItems.push(bullet[1]);
      return;
    }
    flushList(idx);
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2]);
      elements.push(
        <div
          key={`h-${idx}`}
          className={cn(
            'font-semibold tracking-tight text-foreground',
            level === 1 ? 'text-base' : 'text-sm',
          )}
        >
          {content}
        </div>,
      );
      return;
    }
    elements.push(
      <p key={`p-${idx}`} className="text-sm leading-relaxed text-foreground/90">
        {renderInlineMarkdown(line)}
      </p>,
    );
  });

  flushList(lines.length);
  return <div className="space-y-1.5">{elements}</div>;
}

interface ParsedSeries {
  name: string;
  values: number[];
}

function extractSeriesList(raw: OpenUIValue): ParsedSeries[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item, idx): ParsedSeries | null => {
      if (isOpenUIComponentNode(item) && item.name === 'Series') {
        const name = toDisplayString(item.args[0] ?? `Series ${idx + 1}`);
        const vals = Array.isArray(item.args[1])
          ? item.args[1].map((v) => (typeof v === 'number' ? v : Number(v) || 0))
          : [];
        return { name, values: vals };
      }
      if (item && typeof item === 'object' && !Array.isArray(item) && !isOpenUIComponentNode(item)) {
        const obj = item as Record<string, OpenUIValue>;
        const name = toDisplayString(obj.name ?? obj.label ?? `Series ${idx + 1}`);
        const valsRaw = obj.values ?? obj.data;
        const vals = Array.isArray(valsRaw)
          ? valsRaw.map((v) => (typeof v === 'number' ? v : Number(v) || 0))
          : [];
        return { name, values: vals };
      }
      if (typeof item === 'number') {
        return { name: `Series 1`, values: raw.map((v) => Number(v) || 0) };
      }
      return null;
    })
    .filter((s): s is ParsedSeries => s !== null);
}

/**
 * 扫描 AST 提取表单控件的初始默认值
 */
function collectDefaultFormValues(node: OpenUIValue, out: Record<string, unknown>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => collectDefaultFormValues(child, out));
    return;
  }
  if (!isOpenUIComponentNode(node)) {
    Object.values(node).forEach((v) => collectDefaultFormValues(v, out));
    return;
  }

  switch (node.name) {
    case 'Choice': {
      const name = toDisplayString(node.namedArgs?.name ?? node.namedArgs?.field ?? node.args[0]);
      const multiple = Boolean(node.namedArgs?.multiple ?? node.args[3]);
      if (name && !(name in out)) {
        out[name] = multiple ? [] : '';
      }
      break;
    }
    case 'Input': {
      const name = toDisplayString(node.namedArgs?.name ?? node.namedArgs?.field ?? node.args[0]);
      const rawDefault =
        node.namedArgs?.default ??
        node.namedArgs?.value ??
        (node.args[4] !== undefined ? node.args[4] : undefined);
      const defVal = rawDefault !== undefined ? toDisplayString(rawDefault) : '';
      if (name && !(name in out)) {
        out[name] = defVal;
      }
      break;
    }
    case 'DateInput': {
      const name = toDisplayString(node.namedArgs?.name ?? node.namedArgs?.field ?? node.args[0]);
      const rawDefault =
        node.namedArgs?.default ?? (node.args[3] !== undefined ? node.args[3] : undefined);
      const defVal = rawDefault !== undefined ? toDisplayString(rawDefault) : '';
      if (name && !(name in out)) {
        out[name] = defVal;
      }
      break;
    }
    case 'Slider': {
      const name = toDisplayString(node.namedArgs?.name ?? node.namedArgs?.field ?? node.args[0]);
      const min = Number(node.namedArgs?.min ?? node.args[1] ?? 0);
      const rawDefault = node.namedArgs?.default ?? node.namedArgs?.value ?? node.args[5];
      const defVal = rawDefault !== undefined ? Number(rawDefault) : min;
      if (name && !(name in out)) {
        out[name] = Number.isFinite(defVal) ? defVal : min;
      }
      break;
    }
    default:
      break;
  }

  node.args.forEach((arg) => collectDefaultFormValues(arg, out));
  if (node.namedArgs) {
    Object.values(node.namedArgs).forEach((arg) => collectDefaultFormValues(arg, out));
  }
}

function buildSubmissionSummary(
  buttonLabel: string,
  values: Record<string, unknown>,
  note: string,
): string {
  const parts: string[] = [];
  if (buttonLabel) {
    parts.push(buttonLabel);
  }
  for (const [key, val] of Object.entries(values)) {
    if (Array.isArray(val)) {
      if (val.length > 0) parts.push(`${key}: ${val.join(', ')}`);
    } else if (val !== '' && val !== null && val !== undefined) {
      parts.push(`${key}: ${String(val)}`);
    }
  }
  if (note) {
    parts.push(note);
  }
  return parts.join(' · ') || buttonLabel || 'Submitted';
}

const TabsContainer: React.FC<{
  tabs: Array<{ label: string; children: OpenUIValue }>;
  renderValue: (val: OpenUIValue, keyPrefix: string) => React.ReactNode;
}> = ({ tabs, renderValue }) => {
  const [activeIndex, setActiveIndex] = useState(0);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const safeIndex = activeIndex < tabs.length ? activeIndex : 0;

  if (tabs.length === 0) return null;

  const handleTabListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tabs.length === 0) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const nextIdx = (safeIndex + 1) % tabs.length;
      setActiveIndex(nextIdx);
      tabRefs.current[nextIdx]?.focus();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prevIdx = (safeIndex - 1 + tabs.length) % tabs.length;
      setActiveIndex(prevIdx);
      tabRefs.current[prevIdx]?.focus();
    }
  };

  return (
    <div className="space-y-2.5" data-openui-component="Tabs">
      <div
        role="tablist"
        onKeyDown={handleTabListKeyDown}
        className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border/35 bg-muted/40 p-1"
      >
        {tabs.map((tab, idx) => {
          const active = idx === safeIndex;
          return (
            <button
              key={`${idx}-${tab.label}`}
              ref={(el) => {
                tabRefs.current[idx] = el;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => setActiveIndex(idx)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" className="space-y-2.5">
        {renderValue(tabs[safeIndex].children, `tab-panel-${safeIndex}`)}
      </div>
    </div>
  );
};

const DetailsContainer: React.FC<{
  title: string;
  childrenValue: OpenUIValue;
  defaultOpen?: boolean;
  renderValue: (val: OpenUIValue, keyPrefix: string) => React.ReactNode;
}> = ({ title, childrenValue, defaultOpen = false, renderValue }) => {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="rounded-lg border border-border/35 bg-card/40"
      data-openui-component="Details"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-foreground transition-colors hover:bg-muted/40"
      >
        <CaretRight
          size={13}
          className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="flex-1">{title}</span>
      </button>
      {open && (
        <div className="border-t border-border/35 px-3 py-2.5 space-y-2">
          {renderValue(childrenValue, 'details-body')}
        </div>
      )}
    </div>
  );
};

export const OpenUILangRenderer: React.FC<OpenUILangRendererProps> = ({
  source,
  isStreaming = false,
  awaitAnswer = false,
  answer = null,
  disabled = false,
  onSubmit,
  onNotDrawn,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const program = useMemo(() => parseOpenUILang(source), [source]);
  const ensuredAwaitResult = useMemo(
    () =>
      program.root
        ? ensureAwaitAnswerSubmitButton(program.root, { awaitAnswer })
        : null,
    [program.root, awaitAnswer],
  );
  const effectiveRoot = ensuredAwaitResult?.root ?? program.root;
  const lastNotDrawnSourceRef = useRef<string | null>(null);

  useEffect(() => {
    if (isStreaming || effectiveRoot) {
      if (effectiveRoot) {
        lastNotDrawnSourceRef.current = null;
      }
      return;
    }
    if (!onNotDrawn) return;
    if (lastNotDrawnSourceRef.current === source) return;
    lastNotDrawnSourceRef.current = source;
    onNotDrawn(
      buildOnNotDrawnAutoHealResult(
        source,
        program.errors.length > 0 ? program.errors : 'Empty openui-lang program',
      ),
    );
  }, [isStreaming, effectiveRoot, onNotDrawn, source, program.errors]);

  const normalizedAnswer = useMemo<OpenUILangAnswerData | null>(() => {
    if (!answer || typeof answer !== 'object') return null;
    const raw = answer as Record<string, unknown>;
    return {
      button: typeof raw.button === 'string' ? raw.button : '',
      value: typeof raw.value === 'string' ? raw.value : '',
      values:
        raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values)
          ? (raw.values as Record<string, unknown>)
          : {},
      note: typeof raw.note === 'string' ? raw.note : undefined,
    };
  }, [answer]);

  const defaultValues = useMemo(() => {
    const out: Record<string, unknown> = {};
    if (program.root) {
      collectDefaultFormValues(program.root, out);
    }
    return out;
  }, [program.root]);

  const [formValues, setFormValues] = useState<Record<string, unknown>>(() => ({
    ...defaultValues,
    ...(normalizedAnswer?.values ?? {}),
  }));
  const [noteText, setNoteText] = useState<string>(() => normalizedAnswer?.note ?? '');
  const [submittedData, setSubmittedData] = useState<OpenUILangAnswerData | null>(normalizedAnswer);

  useEffect(() => {
    setFormValues((prev) => ({
      ...defaultValues,
      ...prev,
      ...(normalizedAnswer?.values ?? {}),
    }));
    if (normalizedAnswer) {
      setSubmittedData(normalizedAnswer);
      if (normalizedAnswer.note !== undefined) {
        setNoteText(normalizedAnswer.note);
      }
    }
  }, [defaultValues, normalizedAnswer]);

  const isLocked = disabled || isStreaming || Boolean(submittedData);

  const handleFieldChange = useCallback(
    (name: string, val: unknown) => {
      if (isLocked) return;
      setFormValues((prev) => ({ ...prev, [name]: val }));
    },
    [isLocked],
  );

  const handleButtonSubmit = useCallback(
    (buttonLabel: string, buttonValue: string) => {
      if (isLocked) return;
      const mergedValues: Record<string, unknown> = {
        ...defaultValues,
        ...formValues,
      };
      const trimmedNote = noteText.trim();
      const data: OpenUILangAnswerData = {
        button: buttonLabel,
        value: buttonValue,
        values: mergedValues,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      };
      const summary = buildSubmissionSummary(buttonLabel, mergedValues, trimmedNote);
      if (awaitAnswer || onSubmit) {
        setSubmittedData(data);
      }
      void onSubmit?.({ summary, data });
    },
    [awaitAnswer, defaultValues, formValues, isLocked, noteText, onSubmit],
  );

  const renderValue = (val: OpenUIValue, keyPrefix: string): React.ReactNode => {
    if (val === null || val === undefined) return null;
    if (typeof val === 'string') {
      return renderMarkdownBlocks(val);
    }
    if (typeof val === 'number' || typeof val === 'boolean') {
      return <span className="text-sm tabular-nums text-foreground">{String(val)}</span>;
    }
    if (Array.isArray(val)) {
      return val.map((item, idx) => (
        <React.Fragment key={`${keyPrefix}-${idx}`}>
          {renderValue(item, `${keyPrefix}-${idx}`)}
        </React.Fragment>
      ));
    }
    if (isOpenUIComponentNode(val)) {
      return renderComponent(val, keyPrefix);
    }
    return null;
  };

  const renderComponent = (node: OpenUIComponentNode, keyPrefix: string): React.ReactNode => {
    if (node.id === '__await_answer_note_slot') {
      return null;
    }
    const { name, args } = node;
    const named: Record<string, OpenUIValue> = node.namedArgs ?? {};
    const namedText = (...keys: string[]): string | undefined => {
      for (const key of keys) {
        const value = named[key];
        if (typeof value === 'string') return value;
      }
      return undefined;
    };
    const collectChildren = (value: OpenUIValue | undefined): OpenUIValue[] => {
      if (value === undefined || value === null) return [];
      return Array.isArray(value) ? value : [value];
    };

    switch (name) {
      // ======================================================================
      // 布局与容器组件
      // ======================================================================
      case 'Root':
      case 'Stack': {
        const rawChildren = named.children !== undefined ? named.children : args[0];
        const childrenList =
          rawChildren === undefined ? [] : Array.isArray(rawChildren) ? rawChildren : [rawChildren];
        const rawDirection = toDisplayString(
          named.direction ?? (typeof args[1] === 'string' ? args[1] : ''),
        ).toLowerCase();
        const direction = name === 'Root' || rawDirection !== 'row' ? 'column' : 'row';
        return (
          <div
            className={cn(
              direction === 'row'
                ? 'flex flex-wrap items-stretch gap-3 [&>*]:min-w-[140px] [&>*]:flex-1'
                : 'flex flex-col gap-3',
            )}
            data-openui-component={name}
            data-direction={direction}
          >
            {childrenList.map((child, idx) => (
              <React.Fragment key={`${keyPrefix}-stack-${idx}`}>
                {renderValue(child, `${keyPrefix}-stack-${idx}`)}
              </React.Fragment>
            ))}
          </div>
        );
      }

      case 'Row': {
        const rawChildren = named.children !== undefined ? named.children : args[0];
        const children = Array.isArray(rawChildren) ? rawChildren : rawChildren === undefined ? args : [rawChildren];
        return (
          <div
            className="flex flex-wrap items-stretch gap-3 [&>*]:min-w-[140px] [&>*]:flex-1"
            data-openui-component="Row"
          >
            {children.map((child, idx) => (
              <React.Fragment key={`${keyPrefix}-row-${idx}`}>
                {renderValue(child, `${keyPrefix}-row-${idx}`)}
              </React.Fragment>
            ))}
          </div>
        );
      }

      case 'Card': {
        let cardTitle = namedText('title', 'header');
        let cardSubtitle = namedText('subtitle');
        const childValues: OpenUIValue[] = named.children !== undefined
          ? collectChildren(named.children)
          : [];

        if (named.children === undefined && args.length > 0) {
          const positional = [...args];
          if (cardTitle === undefined && typeof positional[0] === 'string') {
            cardTitle = positional.shift() as string;
          } else if (cardTitle !== undefined && positional[0] === cardTitle) {
            // 具名 title 同时以位置参数重复出现时只保留一份
            positional.shift();
          }
          // 兼容 Card(title, children, subtitle) 旧签名：第三位字符串是副标题
          if (
            args.length >= 3 &&
            cardSubtitle === undefined &&
            positional.length >= 2 &&
            typeof positional[1] === 'string'
          ) {
            cardSubtitle = positional[1] as string;
            positional.splice(1, 1);
          }
          positional.forEach((value) => childValues.push(...collectChildren(value)));
        }

        return (
          <div
            className="rounded-lg border border-border/35 bg-card/50 p-3.5 space-y-2.5"
            data-openui-component="Card"
          >
            {(cardTitle || cardSubtitle) && (
              <div className="space-y-0.5">
                {cardTitle && <div className="text-sm font-semibold text-foreground">{cardTitle}</div>}
                {cardSubtitle && <div className="text-xs text-muted-foreground">{cardSubtitle}</div>}
              </div>
            )}
            {childValues.length > 0 && (
              <div className="space-y-2.5">
                {childValues.map((child, idx) => (
                  <React.Fragment key={`${keyPrefix}-card-${idx}`}>
                    {renderValue(child, `${keyPrefix}-card-${idx}`)}
                  </React.Fragment>
                ))}
              </div>
            )}
          </div>
        );
      }

      case 'Tabs': {
        const rawTabs = Array.isArray(named.tabs)
          ? named.tabs
          : Array.isArray(named.items)
            ? named.items
            : Array.isArray(args[0])
              ? args[0]
              : args;
        const parsedTabs = rawTabs
          .map((item, idx): { label: string; children: OpenUIValue } | null => {
            if (isOpenUIComponentNode(item) && item.name === 'Tab') {
              return {
                label: toDisplayString(item.namedArgs?.label ?? item.args[0] ?? `Tab ${idx + 1}`),
                children: item.namedArgs?.children ?? item.args[1] ?? null,
              };
            }
            if (item && typeof item === 'object' && !Array.isArray(item) && !isOpenUIComponentNode(item)) {
              const obj = item as Record<string, OpenUIValue>;
              return {
                label: toDisplayString(obj.label ?? obj.title ?? `Tab ${idx + 1}`),
                children: obj.children ?? obj.content ?? null,
              };
            }
            return null;
          })
          .filter((t): t is { label: string; children: OpenUIValue } => t !== null);

        return <TabsContainer tabs={parsedTabs} renderValue={renderValue} />;
      }

      case 'Tab': {
        const label = namedText('label', 'title') ?? toDisplayString(args[0]);
        const children = named.children ?? named.content ?? args[1];
        return (
          <div className="space-y-2" data-openui-component="Tab" data-tab-label={label}>
            {renderValue(children, `${keyPrefix}-tab`)}
          </div>
        );
      }

      case 'Accordion': {
        const rawItems = Array.isArray(named.items)
          ? named.items
          : Array.isArray(args[0])
            ? args[0]
            : [];
        return (
          <div className="space-y-2" data-openui-component="Accordion">
            {rawItems.map((item, idx) => {
              let title = '';
              let content: OpenUIValue = null;
              let defaultOpen = false;
              if (isOpenUIComponentNode(item)) {
                title = toDisplayString(item.args[0] ?? `Item ${idx + 1}`);
                content = item.args[1] ?? null;
                defaultOpen = Boolean(item.args[2]);
              } else if (item && typeof item === 'object' && !Array.isArray(item)) {
                const obj = item as Record<string, OpenUIValue>;
                title = toDisplayString(obj.title ?? obj.label ?? `Item ${idx + 1}`);
                content = obj.content ?? obj.children ?? obj.body ?? null;
                defaultOpen = Boolean(obj.open ?? obj.defaultOpen);
              } else if (typeof item === 'string') {
                title = item;
              }
              return (
                <DetailsContainer
                  key={`${keyPrefix}-accordion-${idx}`}
                  title={title}
                  childrenValue={content}
                  defaultOpen={defaultOpen}
                  renderValue={renderValue}
                />
              );
            })}
          </div>
        );
      }

      case 'Details': {
        const title = namedText('title', 'label') ?? toDisplayString(args[0]);
        const children = named.content ?? named.children ?? args[1];
        const defaultOpen = Boolean(named.open ?? named.defaultOpen ?? args[2]);
        return (
          <DetailsContainer
            title={title}
            childrenValue={children}
            defaultOpen={defaultOpen}
            renderValue={renderValue}
          />
        );
      }

      // ======================================================================
      // 文本与数据组件
      // ======================================================================
      case 'Header':
      case 'TextContent':
      case 'Text': {
        const rawText =
          named.text ??
          named.content ??
          named.children ??
          args[0];
        const markdown = Array.isArray(rawText)
          ? rawText.map(toDisplayString).join('\n')
          : toDisplayString(rawText);
        const rawSize = toDisplayString(
          named.size ?? (typeof args[1] === 'string' ? args[1] : ''),
        ).toLowerCase();
        const size =
          rawSize === 'sm' || rawSize === 'md' || rawSize === 'lg' || rawSize === 'xl'
            ? rawSize
            : name === 'Header'
              ? 'lg'
              : 'md';
        return (
          <div
            data-openui-component={name}
            data-size={size}
            className={cn(
              size === 'sm' && 'text-xs',
              size === 'lg' && 'text-base font-semibold tracking-tight',
              size === 'xl' && 'text-lg font-semibold tracking-tight',
            )}
          >
            {renderMarkdownBlocks(markdown)}
          </div>
        );
      }

      case 'Badge': {
        const label = namedText('label', 'text', 'title') ?? toDisplayString(args[0]);
        const tone = normalizeTone(named.tone ?? named.variant ?? args[1]);
        const toneClasses: Record<Tone, string> = {
          default: 'bg-muted text-foreground border-border/35',
          info: 'bg-info/12 text-info border-info/25',
          success: 'bg-success/12 text-success border-success/25',
          warning: 'bg-warning/12 text-warning border-warning/25',
          error: 'bg-destructive/12 text-destructive border-destructive/25',
          destructive: 'bg-destructive/12 text-destructive border-destructive/25',
        };
        return (
          <span
            data-openui-component="Badge"
            data-tone={tone}
            className={cn(
              'inline-flex w-fit items-center rounded-md border px-2 py-0.5 text-xs font-medium',
              toneClasses[tone],
            )}
          >
            {label}
          </span>
        );
      }

      case 'Callout': {
        const rawMarkdown = named.text ?? named.content ?? named.message ?? args[0];
        const markdown = Array.isArray(rawMarkdown)
          ? rawMarkdown.map(toDisplayString).join('\n')
          : toDisplayString(rawMarkdown);
        const tone = normalizeTone(named.tone ?? named.variant ?? args[1]);
        const title = namedText('title') ?? (args[2] ? toDisplayString(args[2]) : '');
        const toneStyles: Record<Tone, { box: string; icon: React.ReactNode }> = {
          default: {
            box: 'border-border/35 bg-muted/35 text-foreground',
            icon: <Info size={16} className="mt-0.5 shrink-0 text-muted-foreground" />,
          },
          info: {
            box: 'border-info/30 bg-info/8 text-foreground',
            icon: <Info size={16} className="mt-0.5 shrink-0 text-info" />,
          },
          success: {
            box: 'border-success/30 bg-success/8 text-foreground',
            icon: <CheckCircle size={16} className="mt-0.5 shrink-0 text-success" />,
          },
          warning: {
            box: 'border-warning/30 bg-warning/8 text-foreground',
            icon: <Warning size={16} className="mt-0.5 shrink-0 text-warning" />,
          },
          error: {
            box: 'border-destructive/30 bg-destructive/8 text-foreground',
            icon: <WarningCircle size={16} className="mt-0.5 shrink-0 text-destructive" />,
          },
          destructive: {
            box: 'border-destructive/30 bg-destructive/8 text-foreground',
            icon: <WarningCircle size={16} className="mt-0.5 shrink-0 text-destructive" />,
          },
        };
        const style = toneStyles[tone];
        return (
          <div
            data-openui-component="Callout"
            data-tone={tone}
            className={cn('flex items-start gap-2.5 rounded-lg border px-3 py-2.5', style.box)}
          >
            {style.icon}
            <div className="min-w-0 flex-1 space-y-1">
              {title && <div className="text-xs font-semibold text-foreground">{title}</div>}
              {renderMarkdownBlocks(markdown)}
            </div>
          </div>
        );
      }

      case 'KeyValue': {
        const rawSource = Array.isArray(named.items)
          ? named.items
          : Array.isArray(named.rows)
            ? named.rows
            : Array.isArray(args[0])
              ? args[0]
              : args;
        const rawItems = rawSource;
        const items = rawItems
          .map((item): { label: string; value: OpenUIValue } | null => {
            if (Array.isArray(item) && item.length >= 2) {
              return { label: toDisplayString(item[0]), value: item[1] };
            }
            if (item && typeof item === 'object' && !Array.isArray(item) && !isOpenUIComponentNode(item)) {
              const obj = item as Record<string, OpenUIValue>;
              return {
                label: toDisplayString(obj.label ?? obj.key ?? obj.name ?? ''),
                value: obj.value ?? obj.val ?? '',
              };
            }
            return null;
          })
          .filter((kv): kv is { label: string; value: OpenUIValue } => kv !== null);

        return (
          <dl
            data-openui-component="KeyValue"
            className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg border border-border/35 bg-muted/20 px-3 py-2.5 sm:grid-cols-2"
          >
            {items.map((item, idx) => {
              const valStr = toDisplayString(item.value);
              return (
                <div
                  key={`${idx}-${item.label}`}
                  className="flex items-baseline justify-between gap-2 border-b border-border/35 pb-1.5 last:border-b-0 sm:border-b-0 sm:pb-0"
                >
                  <dt className="text-xs text-muted-foreground">{item.label}</dt>
                  <dd
                    className={cn(
                      'text-xs font-medium text-foreground',
                      isNumericLike(valStr) && 'font-mono tabular-nums',
                    )}
                  >
                    {isOpenUIComponentNode(item.value)
                      ? renderComponent(item.value, `${keyPrefix}-kv-${idx}`)
                      : valStr}
                  </dd>
                </div>
              );
            })}
          </dl>
        );
      }

      case 'Table': {
        const rawCols = Array.isArray(named.columns)
          ? named.columns
          : Array.isArray(args[0])
            ? args[0]
            : [];
        const rawRows = Array.isArray(named.rows)
          ? named.rows
          : Array.isArray(args[1])
            ? args[1]
            : [];
        const allStringColumns = rawCols.every((col) => typeof col === 'string');
        const columns = rawCols.map((col, idx) => {
          if (typeof col === 'string') {
            // 纯字符串表头（Table(["方案", "复杂度"], [["PS", "O(K)"]])) 用 col_N 作为行键
            return { key: allStringColumns ? `col_${idx}` : col, label: col, index: idx };
          }
          if (col && typeof col === 'object' && !Array.isArray(col) && !isOpenUIComponentNode(col)) {
            const obj = col as Record<string, OpenUIValue>;
            const key = toDisplayString(obj.key ?? obj.label ?? idx);
            const label = toDisplayString(
              obj.label ?? obj.title ?? obj.name ?? obj.header ?? obj.key ?? idx,
            );
            return { key, label, index: idx };
          }
          return { key: `col_${idx}`, label: toDisplayString(col), index: idx };
        });

        return (
          <div
            data-openui-component="Table"
            className="overflow-x-auto rounded-lg border border-border/35"
          >
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-border/35 bg-muted/40">
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className="px-3 py-2 font-semibold text-muted-foreground whitespace-nowrap"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border/35">
                {rawRows.map((row, rIdx) => {
                  const cells = Array.isArray(row)
                    ? columns.map((_, cIdx) => row[cIdx] ?? null)
                    : row && typeof row === 'object' && !isOpenUIComponentNode(row)
                      ? columns.map((col) => {
                          const record = row as Record<string, OpenUIValue>;
                          return record[col.key] ?? record[col.label] ?? null;
                        })
                      : [row];

                  return (
                    <tr key={rIdx} className="hover:bg-muted/20">
                      {cells.map((cell, cIdx) => {
                        const cellText = toDisplayString(cell);
                        const numeric = isNumericLike(cellText);
                        return (
                          <td
                            key={cIdx}
                            className={cn(
                              'px-3 py-2 text-foreground',
                              numeric && 'font-mono tabular-nums text-right',
                            )}
                          >
                            {isOpenUIComponentNode(cell)
                              ? renderComponent(cell, `${keyPrefix}-cell-${rIdx}-${cIdx}`)
                              : cellText}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      }

      case 'Stat': {
        const label = namedText('label', 'title', 'name') ?? toDisplayString(args[0]);
        const value =
          named.value !== undefined ? toDisplayString(named.value) : toDisplayString(args[1]);
        const rawDelta = named.change ?? named.delta ?? args[2];
        const delta = rawDelta !== undefined && rawDelta !== null ? toDisplayString(rawDelta) : '';
        const tone = normalizeTone(
          named.trend ??
            named.tone ??
            args[3] ??
            (delta.startsWith('+') ? 'success' : delta.startsWith('-') ? 'error' : 'default'),
        );
        const deltaColor =
          tone === 'success'
            ? 'text-success'
            : tone === 'error'
              ? 'text-destructive'
              : tone === 'warning'
                ? 'text-warning'
                : tone === 'info'
                  ? 'text-info'
                  : 'text-muted-foreground';

        const DeltaIcon =
          tone === 'success' ? TrendUp : tone === 'error' ? TrendDown : delta ? Minus : null;

        return (
          <div
            data-openui-component="Stat"
            data-tone={tone}
            className="flex flex-col justify-between rounded-lg border border-border/35 bg-card/40 px-3.5 py-2.5"
          >
            <span className="text-xs text-muted-foreground">{label}</span>
            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</span>
              {delta && (
                <span className={cn('inline-flex items-center gap-1 font-mono text-xs font-medium tabular-nums', deltaColor)}>
                  {DeltaIcon && <DeltaIcon size={12} aria-hidden />}
                  {delta}
                </span>
              )}
            </div>
          </div>
        );
      }

      case 'Progress': {
        const label = namedText('label', 'title') ?? toDisplayString(args[0]);
        const rawValue = named.value ?? args[1];
        const value = Number(rawValue ?? 0);
        const third = named.max ?? named.total ?? args[2];
        const captionText = namedText('caption', 'hint');
        const numericMax = typeof third === 'number' && Number.isFinite(third) && third > 0
          ? third
          : typeof third === 'string' && /^\d+(?:\.\d+)?$/.test(third.trim())
            ? Number(third)
            : undefined;
        const max = numericMax ?? 100;
        const pct = Math.max(0, Math.min(100, Math.round((Number(value) / max) * 100)));
        // 第三位为字符串时是说明文案；为数字时是 max（沿用 `value / max (pct%)` 展示）。
        const caption =
          captionText ?? (typeof third === 'string' && numericMax === undefined ? third : undefined);

        return (
          <div data-openui-component="Progress" className="space-y-1.5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">{label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {caption ?? `${value} / ${max} (${pct}%)`}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      }

      case 'Steps': {
        const rawItems = Array.isArray(named.items)
          ? named.items
          : Array.isArray(named.steps)
            ? named.steps
            : Array.isArray(args[0])
              ? args[0]
              : [];
        const direction =
          toDisplayString(named.direction ?? args[1]).toLowerCase() === 'horizontal'
            ? 'horizontal'
            : 'vertical';

        return (
          <ol
            data-openui-component="Steps"
            data-direction={direction}
            className={cn(
              direction === 'horizontal'
                ? 'flex flex-wrap items-start gap-4'
                : 'space-y-2.5',
            )}
          >
            {rawItems.map((item, idx) => {
              let title = '';
              let description = '';
              let status = 'pending';

              if (typeof item === 'string') {
                title = item;
              } else if (item && typeof item === 'object' && !Array.isArray(item) && !isOpenUIComponentNode(item)) {
                const obj = item as Record<string, OpenUIValue>;
                title = toDisplayString(obj.title ?? obj.label ?? obj.name ?? `Step ${idx + 1}`);
                description = toDisplayString(obj.description ?? obj.detail ?? obj.markdown ?? '');
                status = normalizeStepStatus(obj.status ?? 'pending') || 'pending';
              }

              const iconNode =
                status === 'done' || status === 'completed' ? (
                  <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-success" />
                ) : status === 'active' || status === 'in_progress' || status === 'running' ? (
                  <Circle size={16} weight="fill" className="mt-0.5 shrink-0 text-info" />
                ) : status === 'error' || status === 'failed' ? (
                  <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
                ) : status === 'skipped' ? (
                  <MinusCircle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Circle size={16} className="mt-0.5 shrink-0 text-muted-foreground" />
                );

              return (
                <li
                  key={`${idx}-${title}`}
                  data-step-status={status}
                  className="flex items-start gap-2.5 text-xs"
                >
                  {iconNode}
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-foreground">{title}</div>
                    {description && <div className="mt-0.5 text-muted-foreground">{description}</div>}
                  </div>
                </li>
              );
            })}
          </ol>
        );
      }

      case 'Chart': {
        const rawVariant = toDisplayString(
          named.variant ??
            named.kind ??
            named.type ??
            (typeof args[3] === 'string' ? args[3] : typeof args[0] === 'string' ? args[0] : ''),
        ).toLowerCase();
        const hasVariantFirst = typeof args[0] === 'string';
        const chartArgs: OpenUIValue[] = hasVariantFirst
          ? [args[1] ?? null, args[2] ?? null, args[3] ?? null]
          : [args[0] ?? null, args[1] ?? null, args[2] ?? null];
        if (named.categories !== undefined) chartArgs[0] = named.categories;
        if (named.series !== undefined) chartArgs[1] = named.series;
        if (named.unit !== undefined) chartArgs[2] = named.unit;
        return renderComponent(
          {
            ...node,
            name: rawVariant === 'line' ? 'LineChart' : 'BarChart',
            args: chartArgs,
            namedArgs: undefined,
          },
          keyPrefix,
        );
      }

      case 'BarChart': {
        const rawLabels = named.categories ?? named.labels ?? args[0];
        const rawSeries = named.series ?? named.data ?? args[1];
        const rawUnit = named.unit ?? args[2];
        const labels = Array.isArray(rawLabels) ? rawLabels.map(toDisplayString) : [];
        const series = extractSeriesList(rawSeries);
        const unit = rawUnit ? toDisplayString(rawUnit) : '';
        const allValues = series.flatMap((s) => s.values);
        const maxVal = Math.max(1, ...allValues, 0);

        return (
          <div
            data-openui-component="BarChart"
            className="rounded-lg border border-border/35 bg-card/40 p-3 space-y-3"
          >
            {series.length > 1 && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                {series.map((s, sIdx) => (
                  <span key={s.name} className="inline-flex items-center gap-1.5">
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: CHART_COLORS[sIdx % CHART_COLORS.length] }}
                    />
                    <span>{s.name}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {labels.map((label, lIdx) => (
                <div key={`${lIdx}-${label}`} className="space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">{label}</span>
                    <span className="font-mono tabular-nums font-medium text-foreground">
                      {series
                        .map((s) => `${s.values[lIdx] ?? 0}${unit ? ` ${unit}` : ''}`)
                        .join(' / ')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {series.map((s, sIdx) => {
                      const v = s.values[lIdx] ?? 0;
                      const pct = Math.max(2, Math.min(100, Math.round((v / maxVal) * 100)));
                      return (
                        <div key={`${s.name}-${sIdx}`} className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{
                              width: `${pct}%`,
                              background: CHART_COLORS[sIdx % CHART_COLORS.length],
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      }

      case 'LineChart': {
        const rawLabels = named.categories ?? named.labels ?? args[0];
        const rawSeries = named.series ?? named.data ?? args[1];
        const rawUnit = named.unit ?? args[2];
        const labels = Array.isArray(rawLabels) ? rawLabels.map(toDisplayString) : [];
        const series = extractSeriesList(rawSeries);
        const unit = rawUnit ? toDisplayString(rawUnit) : '';
        const allValues = series.flatMap((s) => s.values);
        const minVal = Math.min(0, ...allValues);
        const maxVal = Math.max(minVal + 1, ...allValues);
        const width = 480;
        const height = 140;
        const padX = 24;
        const padY = 16;

        return (
          <div
            data-openui-component="LineChart"
            className="rounded-lg border border-border/35 bg-card/40 p-3 space-y-2.5"
          >
            {series.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <div className="flex flex-wrap items-center gap-3">
                  {series.map((s, sIdx) => (
                    <span key={s.name} className="inline-flex items-center gap-1.5">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: CHART_COLORS[sIdx % CHART_COLORS.length] }}
                      />
                      <span>{s.name}</span>
                    </span>
                  ))}
                </div>
                {unit && <span>{unit}</span>}
              </div>
            )}
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="h-36 w-full overflow-visible"
              role="img"
              aria-label={t('openuiLang.lineChartAria')}
            >
              {series.map((s, sIdx) => {
                const count = Math.max(1, s.values.length);
                const points = s.values
                  .map((v, idx) => {
                    const x =
                      count === 1
                        ? width / 2
                        : padX + (idx / (count - 1)) * (width - padX * 2);
                    const y =
                      height -
                      padY -
                      ((v - minVal) / (maxVal - minVal)) * (height - padY * 2);
                    return `${Math.round(x)},${Math.round(y)}`;
                  })
                  .join(' ');
                return (
                  <polyline
                    key={s.name}
                    fill="none"
                    stroke={CHART_COLORS[sIdx % CHART_COLORS.length]}
                    strokeWidth={2}
                    points={points}
                  />
                );
              })}
            </svg>
            {labels.length > 0 && (
              <div className="flex items-center justify-between text-[11px] tabular-nums text-muted-foreground">
                {labels.map((label, idx) => (
                  <span key={`${idx}-${label}`}>{label}</span>
                ))}
              </div>
            )}
          </div>
        );
      }

      // ======================================================================
      // 交互表单控件
      // ======================================================================
      case 'Choice': {
        const fieldName = namedText('name', 'field') ?? toDisplayString(args[0]);
        const rawOptions = Array.isArray(named.options)
          ? named.options
          : Array.isArray(named.choices)
            ? named.choices
            : Array.isArray(args[1])
              ? args[1]
              : [];
        const label = namedText('label', 'title') ?? (args[2] ? toDisplayString(args[2]) : '');
        const multiple = Boolean(named.multiple ?? args[3]);
        const currentValue = formValues[fieldName];

        const options = rawOptions.map((opt) => {
          if (typeof opt === 'string' || typeof opt === 'number') {
            const s = String(opt);
            return { label: s, value: s, description: '' };
          }
          if (opt && typeof opt === 'object' && !Array.isArray(opt) && !isOpenUIComponentNode(opt)) {
            const obj = opt as Record<string, OpenUIValue>;
            const optLabel = toDisplayString(obj.label ?? obj.title ?? obj.value ?? '');
            const optValue = toDisplayString(obj.value ?? obj.label ?? '');
            const description = toDisplayString(obj.description ?? obj.reason ?? '');
            return { label: optLabel, value: optValue, description };
          }
          return { label: toDisplayString(opt), value: toDisplayString(opt), description: '' };
        });

        const handleSelect = (optValue: string) => {
          if (isLocked) return;
          if (multiple) {
            const prevArr = Array.isArray(currentValue) ? (currentValue as string[]) : [];
            const nextArr = prevArr.includes(optValue)
              ? prevArr.filter((v) => v !== optValue)
              : [...prevArr, optValue];
            handleFieldChange(fieldName, nextArr);
          } else {
            handleFieldChange(fieldName, currentValue === optValue ? '' : optValue);
          }
        };

        return (
          <div data-openui-component="Choice" data-field-name={fieldName} className="space-y-1.5">
            {label && <div className="text-xs font-medium text-foreground">{label}</div>}
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {options.map((opt, idx) => {
                const selected = multiple
                  ? Array.isArray(currentValue) && currentValue.includes(opt.value)
                  : currentValue === opt.value;
                return (
                  <button
                    key={`${idx}-${opt.value}`}
                    type="button"
                    disabled={isLocked}
                    aria-pressed={selected}
                    onClick={() => handleSelect(opt.value)}
                    className={cn(
                      'flex items-start justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors',
                      selected
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border/35 bg-card/40 text-foreground hover:bg-muted/40',
                      isLocked && 'cursor-default opacity-80',
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{opt.label}</div>
                      {opt.description && (
                        <div className="mt-0.5 text-[11px] text-muted-foreground">{opt.description}</div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        selected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border/35 bg-transparent text-transparent',
                      )}
                    >
                      <Check size={10} weight="bold" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      }

      case 'Input': {
        const fieldName = namedText('name', 'field') ?? toDisplayString(args[0]);
        const label = namedText('label', 'title') ?? (args[1] ? toDisplayString(args[1]) : '');
        const placeholder =
          namedText('placeholder') ?? (args[2] ? toDisplayString(args[2]) : '');
        const multiline = Boolean(named.multiline ?? args[3]);
        const val = String(formValues[fieldName] ?? '');

        return (
          <label
            data-openui-component="Input"
            data-field-name={fieldName}
            className="block space-y-1"
          >
            {label && <span className="block text-xs font-medium text-foreground">{label}</span>}
            {multiline ? (
              <textarea
                rows={3}
                value={val}
                disabled={isLocked}
                placeholder={placeholder}
                onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                className="w-full rounded-md border border-border/35 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-70"
              />
            ) : (
              <input
                type="text"
                value={val}
                disabled={isLocked}
                placeholder={placeholder}
                onChange={(e) => handleFieldChange(fieldName, e.target.value)}
                className="w-full rounded-md border border-border/35 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-70"
              />
            )}
          </label>
        );
      }

      case 'DateInput': {
        const fieldName = namedText('name', 'field') ?? toDisplayString(args[0]);
        const label = namedText('label', 'title') ?? (args[1] ? toDisplayString(args[1]) : '');
        const includeTime = Boolean(named.includeTime ?? named.time ?? args[2]);
        const val = String(formValues[fieldName] ?? '');

        return (
          <label
            data-openui-component="DateInput"
            data-field-name={fieldName}
            className="block space-y-1"
          >
            {label && <span className="block text-xs font-medium text-foreground">{label}</span>}
            <input
              type={includeTime ? 'datetime-local' : 'date'}
              value={val}
              disabled={isLocked}
              onChange={(e) => handleFieldChange(fieldName, e.target.value)}
              className="w-full rounded-md border border-border/35 bg-background px-2.5 py-1.5 text-xs tabular-nums text-foreground outline-none focus:border-primary disabled:opacity-70"
            />
          </label>
        );
      }

      case 'Slider': {
        const fieldName = namedText('name', 'field') ?? toDisplayString(args[0]);
        const min = Number(named.min ?? args[1] ?? 0);
        const max = Number(named.max ?? args[2] ?? 100);
        const label = namedText('label', 'title') ?? (args[3] ? toDisplayString(args[3]) : fieldName);
        const step = Number(named.step ?? args[4] ?? 1) || 1;
        const unit = namedText('unit') ?? (args[6] ? toDisplayString(args[6]) : '');
        const rawDefault = named.default ?? named.value ?? args[5];
        const current = Number(formValues[fieldName] ?? rawDefault ?? min);

        return (
          <label
            data-openui-component="Slider"
            data-field-name={fieldName}
            className="block space-y-1"
          >
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">{label}</span>
              <span className="font-mono tabular-nums text-muted-foreground">
                {current}
                {unit ? ` ${unit}` : ''}
              </span>
            </div>
            <input
              type="range"
              min={min}
              max={max}
              step={step}
              value={current}
              disabled={isLocked}
              onChange={(e) => handleFieldChange(fieldName, Number(e.target.value))}
              className="w-full accent-primary disabled:opacity-70"
            />
          </label>
        );
      }

      case 'Button': {
        const label = namedText('label', 'title', 'text') ?? toDisplayString(args[0] ?? 'Submit');
        const variant = (namedText('variant') ?? toDisplayString(args[1] ?? 'primary')).toLowerCase();
        const rawValue = named.value !== undefined ? named.value : args[2];
        const value = rawValue !== undefined ? toDisplayString(rawValue) : label;
        const isChosen =
          submittedData !== null &&
          (submittedData.value === value || submittedData.button === label);

        const variantClasses =
          variant === 'outline' || variant === 'secondary'
            ? 'border border-border/35 bg-background text-foreground hover:bg-muted/50'
            : variant === 'destructive' || variant === 'danger'
              ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
              : variant === 'ghost'
                ? 'bg-transparent text-foreground hover:bg-muted/50'
                : 'bg-primary text-primary-foreground hover:bg-primary/90';

        return (
          <button
            type="button"
            data-openui-component="Button"
            data-variant={variant}
            aria-pressed={isChosen || undefined}
            disabled={isLocked}
            onClick={() => handleButtonSubmit(label, value)}
            className={cn(
              'inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              variantClasses,
              isChosen && 'ring-2 ring-primary ring-offset-1',
              isLocked && 'cursor-default opacity-75',
            )}
          >
            {isChosen && <Check size={12} weight="bold" />}
            <span>{label}</span>
          </button>
        );
      }

      default:
        return null;
    }
  };

  if (!effectiveRoot) {
    return (
      <div
        className={cn('rounded-lg border border-border/35 bg-card/30 p-3 text-xs text-muted-foreground', className)}
        data-testid="openui-lang-empty"
      >
        {isStreaming ? t('openuiLang.generating') : t('openuiLang.empty')}
      </div>
    );
  }

  const showInteractiveFooter = awaitAnswer || program.hasInteractiveControls;
  const hasAnyButton = program.hasExplicitButton || Boolean(ensuredAwaitResult?.injectedSubmitButton);

  return (
    <div
      className={cn('openui-lang-root space-y-3 text-sm text-foreground', className)}
      data-testid="openui-lang-renderer"
      data-streaming={isStreaming ? 'true' : 'false'}
    >
      {renderComponent(effectiveRoot, 'root')}

      {showInteractiveFooter && (
        <div className="space-y-2 border-t border-border/35 pt-2.5" data-openui-footer="">
          <input
            type="text"
            data-testid="openui-note-input"
            value={noteText}
            disabled={isLocked}
            placeholder={t('openuiLang.notePlaceholder')}
            onChange={(e) => setNoteText(e.target.value)}
            className="w-full rounded-md border border-border/35 bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary disabled:opacity-70"
          />
          {!hasAnyButton && (
            <div className="flex justify-end">
              <button
                type="button"
                data-openui-component="Button"
                disabled={isLocked}
                onClick={() => handleButtonSubmit('Confirm', 'confirm')}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-75"
              >
                <Check size={12} weight="bold" />
                <span>{t('openuiLang.confirm')}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default OpenUILangRenderer;
