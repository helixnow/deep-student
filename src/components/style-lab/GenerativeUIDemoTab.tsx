import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GenerativeUIRenderer } from '@/features/generative-ui/GenerativeUIRenderer';
import { LEARNING_DASHBOARD_EXAMPLE } from '@/features/generative-ui/prompts';
import { learningActionHandlers } from '@/features/generative-ui/handlers/learningActionHandlers';
import { createNotesEditActionHandlers } from '@/features/generative-ui/handlers/notesEditActionHandlers';
import { buildNoteEditSuggestionIntent } from '@/features/generative-ui/utils/buildNoteEditSuggestionIntent';
import { useGenerativeUIStream } from '@/features/generative-ui/hooks/useGenerativeUIStream';
import { HpiasGenerativeResearchPanel } from '@/features/generative-ui/components/HpiasGenerativeResearchPanel';
import { useHpiasStore } from '@/stores/researchStore';
import {
  playStyleLabHpiasDemo,
  STYLE_LAB_HPIAS_DEMO_QUESTION,
  STYLE_LAB_HPIAS_SESSION_ID,
} from '@/features/generative-ui/demo/styleLabHpiasDemo';
import {
  INTENT_RECIPES,
  getIntentRecipe,
  type IntentRecipeId,
} from '@/features/generative-ui/demo/intentRecipes';
import { buildAllBlocksGridIntent } from '@/features/generative-ui/demo/allBlocksFixture';
import { lintGenerativeUIIntent } from '@/features/generative-ui/utils/lintGenerativeUIIntent';
import { fingerprintGenerativeUIIntent } from '@/features/generative-ui/utils/fingerprintGenerativeUIIntent';
import { diffGenerativeUIIntent } from '@/features/generative-ui/utils/diffGenerativeUIIntent';
import { getDefaultGenerativeUIIntentSnapshotRing } from '@/features/generative-ui/utils/intentSnapshotRing';
import { DsButton } from '@/components/ui/DsButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import type {
  GenerativeActionDefinition,
  GenerativeUIIntent,
} from '@/features/generative-ui/types';

type DemoMode = 'static' | 'stream' | 'note-edit' | 'mindmap' | 'research-hpias' | 'recipe' | 'showcase';

const DEMO_NOTE_ID = 'style-lab-note-demo';
const HPIAS_DEMO_INTERVAL_MS = 350;
const HPIAS_DEMO_DURATION_MS = HPIAS_DEMO_INTERVAL_MS * 14;

const EMPTY_ACTION_HANDLERS: Record<string, GenerativeActionDefinition> = {};

const SHOWCASE_ACTION_HANDLERS: Record<string, GenerativeActionDefinition> = {
  'demo-action': {
    id: 'demo-action',
    label: '操作',
    riskLevel: 'low',
    handler: async () => {
      window.dispatchEvent(
        new CustomEvent('deepstudent:generative-ui-demo-action', {
          detail: { action: 'demo-action' },
        }),
      );
    },
  },
};

const MINDMAP_DEMO_INTENT: GenerativeUIIntent = {
  version: '1',
  meta: { title: '知识图谱预览', description: 'Style Lab — mindmap-embed 块演示' },
  blocks: [
    {
      type: 'stat-card',
      props: { title: '节点数', value: 8, trend: 'up', trendLabel: '本周 +2' },
    },
    {
      type: 'mindmap-embed',
      props: {
        versionId: 'mv_style_lab_demo',
        title: '复习导图',
        height: 280,
      },
    },
  ],
};

/**
 * Style Lab — Generative UI 演示页签
 */
export function GenerativeUIDemoTab() {
  const { t } = useTranslation('generativeUi');
  const stream = useGenerativeUIStream();
  const [mode, setMode] = useState<DemoMode>('static');
  const [recipeId, setRecipeId] = useState<IntentRecipeId>('learning-dashboard');
  const [noteEditStatus, setNoteEditStatus] = useState<string | null>(null);
  const [hpiasPlaying, setHpiasPlaying] = useState(false);
  const hpiasCancelRef = React.useRef<(() => void) | null>(null);
  const hpiasStatusTimerRef = React.useRef<number | null>(null);
  const streamTimerRef = React.useRef<number | null>(null);
  const streamRef = React.useRef(stream);
  streamRef.current = stream;

  const cancelHpiasDemo = React.useCallback(() => {
    hpiasCancelRef.current?.();
    hpiasCancelRef.current = null;
    if (hpiasStatusTimerRef.current !== null) {
      window.clearTimeout(hpiasStatusTimerRef.current);
      hpiasStatusTimerRef.current = null;
    }
  }, []);

  const cancelStreamDemo = React.useCallback(() => {
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
  }, []);

  React.useEffect(() => {
    return () => {
      cancelHpiasDemo();
      cancelStreamDemo();
    };
  }, [cancelHpiasDemo, cancelStreamDemo]);

  React.useEffect(() => {
    if (mode !== 'research-hpias') cancelHpiasDemo();
    if (mode !== 'stream') cancelStreamDemo();
  }, [cancelHpiasDemo, cancelStreamDemo, mode]);

  const startHpiasDemo = React.useCallback(() => {
    cancelHpiasDemo();
    const store = useHpiasStore.getState();
    store.actions.reset(STYLE_LAB_HPIAS_SESSION_ID, 0);
    setHpiasPlaying(true);
    setMode('research-hpias');
    hpiasCancelRef.current = playStyleLabHpiasDemo(
      store.actions.handleEvent,
      HPIAS_DEMO_INTERVAL_MS,
    );
    hpiasStatusTimerRef.current = window.setTimeout(() => {
      hpiasStatusTimerRef.current = null;
      hpiasCancelRef.current = null;
      setHpiasPlaying(false);
    }, HPIAS_DEMO_DURATION_MS);
  }, [cancelHpiasDemo]);

  const noteEditIntent = useMemo(
    () =>
      buildNoteEditSuggestionIntent({
        operation: 'append',
        operationLabel: t('notes.edit_operation_key'),
        previewText: '## Style Lab 演示\n\n这是经 HITL 链写入的 append 建议预览。',
        labels: {
          metaTitle: t('notes.edit_suggestion_title'),
          metaDescription: t('notes.edit_suggestion_description'),
          operationKey: t('notes.edit_operation_key'),
          previewTitle: t('notes.edit_preview_title'),
          applyEdit: t('notes.edit_apply'),
          dismissSuggestion: t('notes.edit_dismiss'),
          suggestionMarkdownTitle: t('notes.edit_suggestion_markdown_title'),
        },
      }),
    [t],
  );

  const noteEditHandlers = useMemo(
    () =>
      createNotesEditActionHandlers(
        {
          noteId: DEMO_NOTE_ID,
          operation: 'append',
          content: '## Style Lab 演示\n\n这是经 HITL 链写入的 append 建议预览。',
        },
        {
          applyEdit: t('notes.edit_apply'),
          dismissSuggestion: t('notes.edit_dismiss'),
        },
        {
          onApplyDispatched: (result) => {
            setNoteEditStatus(
              result.claimed
                ? '已派发 canvas:ai-edit-request（需打开对应笔记编辑器认领）'
                : `未认领：${result.reason ?? '无编辑器'}`,
            );
          },
          onDismiss: () => setNoteEditStatus('已忽略建议'),
        },
      ),
    [t],
  );

  const displayedIntent = useMemo((): GenerativeUIIntent | null => {
    switch (mode) {
      case 'static':
        return LEARNING_DASHBOARD_EXAMPLE;
      case 'recipe':
        return (getIntentRecipe(recipeId) ?? INTENT_RECIPES[0]!).intent;
      case 'showcase':
        return buildAllBlocksGridIntent();
      case 'note-edit':
        return noteEditIntent;
      case 'mindmap':
        return MINDMAP_DEMO_INTENT;
      case 'stream':
        return stream.intent;
      case 'research-hpias':
      default:
        return null;
    }
  }, [mode, recipeId, noteEditIntent, stream.intent]);

  const displayedActionHandlers = useMemo(() => {
    switch (mode) {
      case 'static':
      case 'stream':
        return learningActionHandlers;
      case 'note-edit':
        return noteEditHandlers;
      case 'showcase':
        return SHOWCASE_ACTION_HANDLERS;
      case 'mindmap':
      case 'recipe':
      case 'research-hpias':
      default:
        return EMPTY_ACTION_HANDLERS;
    }
  }, [mode, noteEditHandlers]);

  const lintResult = useMemo(
    () =>
      displayedIntent
        ? lintGenerativeUIIntent(displayedIntent, {
            actionIds: Object.keys(displayedActionHandlers),
          })
        : null,
    [displayedActionHandlers, displayedIntent],
  );

  const intentFingerprint = useMemo(
    () => (displayedIntent ? fingerprintGenerativeUIIntent(displayedIntent) : null),
    [displayedIntent],
  );

  const intentDiff = useMemo(() => {
    if (!displayedIntent || !intentFingerprint) return null;
    const latest = getDefaultGenerativeUIIntentSnapshotRing().latest();
    if (!latest || latest.fingerprint === intentFingerprint) {
      return { added: 0, removed: 0, changed: 0, none: true as const };
    }
    const diff = diffGenerativeUIIntent(latest.intent, displayedIntent);
    return {
      added: diff.added.length,
      removed: diff.removed.length,
      changed: diff.changed.length,
      none: false as const,
    };
  }, [displayedIntent, intentFingerprint]);

  const simulateStream = React.useCallback(() => {
    cancelStreamDemo();
    streamRef.current.reset();
    setMode('stream');
    const json = JSON.stringify(LEARNING_DASHBOARD_EXAMPLE);
    const chunkSize = Math.max(24, Math.floor(json.length / 8));
    let i = 0;
    const tick = () => {
      if (i >= json.length) {
        streamTimerRef.current = null;
        streamRef.current.finalize();
        return;
      }
      streamRef.current.append(json.slice(i, i + chunkSize));
      i += chunkSize;
      streamTimerRef.current = window.setTimeout(tick, 80);
    };
    tick();
  }, [cancelStreamDemo]);

  const renderDemo = () => {
    switch (mode) {
      case 'stream':
        return (
          <GenerativeUIRenderer
            intent={stream.intent ?? LEARNING_DASHBOARD_EXAMPLE}
            isStreaming={stream.isStreaming}
            actionHandlers={learningActionHandlers}
            onAction={() => {}}
          />
        );
      case 'note-edit':
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              演示 noteId={DEMO_NOTE_ID}；apply-note-edit 经 canvas:ai-edit-request HITL 链。
            </p>
            {noteEditStatus ? (
              <p className="text-xs text-primary" data-testid="note-edit-status">
                {noteEditStatus}
              </p>
            ) : null}
            <GenerativeUIRenderer
              intent={noteEditIntent}
              actionHandlers={noteEditHandlers}
              onAction={() => {}}
            />
          </div>
        );
      case 'mindmap':
        return (
          <GenerativeUIRenderer
            intent={MINDMAP_DEMO_INTENT}
            showChrome={false}
            actionHandlers={displayedActionHandlers}
          />
        );
      case 'research-hpias':
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              HpiasStore 事件 → buildHpiasResearchDashboardIntent 实时接线
              {hpiasPlaying ? '（模拟进行中…）' : '（演示完成，可再次播放）'}
            </p>
            <HpiasGenerativeResearchPanel
              showChrome={false}
              question={STYLE_LAB_HPIAS_DEMO_QUESTION}
              emptyFallback={
                <p className="text-sm text-muted-foreground" data-testid="hpias-demo-empty">
                  等待 session_started…
                </p>
              }
            />
          </div>
        );
      case 'recipe': {
        const recipe = getIntentRecipe(recipeId) ?? INTENT_RECIPES[0]!;
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground" data-testid="generative-ui-demo-recipe-desc">
              {t(`${recipe.i18nKey}.title`)} — {t(`${recipe.i18nKey}.description`)}
            </p>
            <GenerativeUIRenderer
              intent={recipe.intent}
              showChrome={false}
              actionHandlers={displayedActionHandlers}
            />
          </div>
        );
      }
      case 'showcase':
        return (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">18 块最小合法 props · v1.1 两列 grid</p>
            <GenerativeUIRenderer
              intent={buildAllBlocksGridIntent()}
              showChrome={false}
              actionHandlers={displayedActionHandlers}
            />
          </div>
        );
      case 'static':
      default:
        return (
          <GenerativeUIRenderer
            intent={LEARNING_DASHBOARD_EXAMPLE}
            actionHandlers={learningActionHandlers}
            onAction={() => {}}
          />
        );
    }
  };

  return (
    <div className="space-y-4" data-testid="generative-ui-demo-tab">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Generative UI 演示</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            结构化意图 + 组件注册表。模型只输出 JSON，渲染受控 shad 组件。
          </p>
          <div className="flex flex-wrap gap-2">
            <DsButton
              size="sm"
              variant={mode === 'static' ? 'default' : 'outline'}
              onClick={() => setMode('static')}
            >
              静态示例
            </DsButton>
            <DsButton size="sm" variant={mode === 'stream' ? 'default' : 'outline'} onClick={simulateStream}>
              模拟流式
            </DsButton>
            <DsButton
              size="sm"
              variant={mode === 'note-edit' ? 'default' : 'outline'}
              onClick={() => {
                setNoteEditStatus(null);
                setMode('note-edit');
              }}
            >
              笔记 HITL
            </DsButton>
            <DsButton
              size="sm"
              variant={mode === 'mindmap' ? 'default' : 'outline'}
              onClick={() => setMode('mindmap')}
            >
              导图嵌入
            </DsButton>
            <DsButton
              size="sm"
              variant={mode === 'research-hpias' ? 'default' : 'outline'}
              onClick={startHpiasDemo}
              data-testid="generative-ui-demo-hpias"
            >
              Research HPIAS
            </DsButton>
            <DsButton
              size="sm"
              variant={mode === 'showcase' ? 'default' : 'outline'}
              onClick={() => setMode('showcase')}
              data-testid="generative-ui-demo-showcase"
            >
              18 块 Showcase
            </DsButton>
          </div>
          <div className="flex flex-wrap gap-2" data-testid="generative-ui-demo-recipes">
            {INTENT_RECIPES.map((recipe) => (
              <DsButton
                key={recipe.id}
                size="sm"
                variant={mode === 'recipe' && recipeId === recipe.id ? 'default' : 'outline'}
                onClick={() => {
                  setRecipeId(recipe.id);
                  setMode('recipe');
                }}
                data-testid={`generative-ui-demo-recipe-${recipe.id}`}
              >
                {t(`${recipe.i18nKey}.title`)}
              </DsButton>
            ))}
          </div>
        </CardContent>
      </Card>

      {lintResult ? (
        <div
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1"
          data-testid="generative-ui-demo-lint"
          data-lint-ok={lintResult.ok ? 'true' : 'false'}
          data-lint-count={lintResult.issues.length}
          data-lint-action-gated="true"
        >
          <p className="font-medium text-foreground">{t('demo.lint_title')}</p>
          {lintResult.ok && lintResult.issues.length === 0 ? (
            <p className="text-muted-foreground">{t('demo.lint_ok')}</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {t('demo.lint_count', { count: lintResult.issues.length })}
              </p>
              <ul className="list-disc pl-4 text-muted-foreground">
                {lintResult.issues.map((issue, index) => (
                  <li key={`${issue.code}-${issue.path ?? index}`} data-lint-code={issue.code}>
                    {issue.code}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {intentFingerprint ? (
        <p
          className="text-xs text-muted-foreground font-mono"
          data-testid="generative-ui-demo-fingerprint"
          data-intent-fingerprint={intentFingerprint}
        >
          {intentFingerprint}
        </p>
      ) : null}

      {intentDiff ? (
        <div
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs space-y-1"
          data-testid="generative-ui-demo-diff"
          data-diff-added={intentDiff.added}
          data-diff-removed={intentDiff.removed}
          data-diff-changed={intentDiff.changed}
        >
          <p className="font-medium text-foreground">{t('demo.diff_title')}</p>
          <p className="text-muted-foreground">
            {intentDiff.none
              ? t('demo.diff_none')
              : t('demo.diff_summary', {
                  added: intentDiff.added,
                  removed: intentDiff.removed,
                  changed: intentDiff.changed,
                })}
          </p>
        </div>
      ) : null}

      {renderDemo()}
    </div>
  );
}
