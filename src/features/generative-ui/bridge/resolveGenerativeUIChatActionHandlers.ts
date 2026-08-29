/**
 * Chat generative_ui 块 — 按 modeState + toolInput 解析 actionHandlers
 */

import i18n from '@/i18n';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import { withGenerativeActionInstrumentation } from '../actions';
import { intentHasResearchBlocks } from '../bridge/hpiasEventBridge';
import { lookupGenerativeActionHandler } from '../actions';
import {
  createWorkbenchLearningHandlers,
  type WorkbenchLearningHandlerLabels,
} from '../handlers/workbenchLearningHandlers';
import {
  createResearchBriefingActionHandlers,
  type ResearchBriefingActionLabels,
} from '../handlers/researchBriefingActionHandlers';
import {
  buildResearchExportMarkdownFromIntent,
  extractResearchReportBody,
} from '../utils/extractResearchContentFromIntent';
import {
  createNotesEditActionHandlers,
  type NotesEditActionLabels,
} from '../handlers/notesEditActionHandlers';
import { extractNoteEditPayload } from '../utils/extractNoteEditPayload';
import {
  COPY_INTENT_ACTION_ID,
  createCopyIntentActionHandlers,
  type CopyIntentActionLabels,
} from '../handlers/copyIntentActionHandlers';
import {
  COPY_BLOCK_ACTION_ID,
  createCopyBlockActionHandlers,
  type CopyBlockActionLabels,
} from '../handlers/copyBlockActionHandlers';
import type { IntentExportMarkdownLabels } from '../utils/buildIntentExportMarkdown';
import type { ResearchExportMarkdownLabels } from '../utils/buildResearchExportMarkdown';
import {
  EXPORT_INTENT_ACTION_ID,
  createExportIntentActionHandlers,
} from '../handlers/exportIntentActionHandlers';
import {
  createOpenResourceActionHandlers,
  parseOpenResourceActionId,
  type OpenNoteActionInput,
  type OpenPdfPageActionInput,
} from '../handlers/openResourceActionHandlers';

/**
 * 未传 labels 时的兜底文案：复用 generativeUi 命名空间既有 key，
 * defaultValue 保留原中文，覆盖延迟命名空间尚未加载完成的窗口期。
 */
function fallbackLabel(key: string, defaultValue: string): string {
  return String(i18n.t(`generativeUi:${key}`, { defaultValue }));
}

export const NOTE_EDIT_ACTION_IDS = ['apply-note-edit', 'dismiss-note-suggestion'] as const;
export const RESEARCH_ACTION_IDS = ['copy-report', 'export-plan', 'export-intent'] as const;
export const COPY_INTENT_ACTION_IDS = [COPY_INTENT_ACTION_ID] as const;
export const COPY_BLOCK_ACTION_IDS = [COPY_BLOCK_ACTION_ID] as const;

export function collectGenerativeUIActionIds(intent: GenerativeUIIntent): string[] {
  return intent.blocks
    .filter((b) => b.type === 'action-bar')
    .flatMap((b) => {
      const actions = (b.props as { actions?: Array<{ id: string }> })?.actions ?? [];
      return actions.map((a) => a.id);
    });
}

export interface ResolveGenerativeUIChatActionHandlersInput {
  canvasNoteId?: string;
  intent: GenerativeUIIntent;
  toolInput?: unknown;
  toolOutput?: unknown;
  noteEditLabels?: NotesEditActionLabels;
  researchLabels?: ResearchBriefingActionLabels;
  copyIntentLabels?: CopyIntentActionLabels;
  copyBlockLabels?: CopyBlockActionLabels;
  workbenchLabels?: WorkbenchLearningHandlerLabels;
  intentExportLabels?: Partial<IntentExportMarkdownLabels>;
  researchExportLabels?: Partial<ResearchExportMarkdownLabels>;
}

/**
 * 合并 workbench + Notes HITL handlers。
 * Chat 块应始终传入返回值（含 workbench 基线），以启用 ActionBar 注册表安全模式。
 */
export function resolveGenerativeUIChatActionHandlers(
  input: ResolveGenerativeUIChatActionHandlersInput,
): Record<string, GenerativeActionDefinition> {
  const actionIds = new Set(collectGenerativeUIActionIds(input.intent));
  const handlers: Record<string, GenerativeActionDefinition> = Object.create(null);
  const workbench = createWorkbenchLearningHandlers(input.workbenchLabels);

  for (const id of actionIds) {
    const handler = lookupGenerativeActionHandler(workbench, id);
    if (handler) handlers[id] = handler;
  }

  const needsNoteHandlers = NOTE_EDIT_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsNoteHandlers && input.canvasNoteId) {
    const noteEdit = extractNoteEditPayload(input.toolInput, input.toolOutput);
    if (noteEdit) {
      Object.assign(
        handlers,
        createNotesEditActionHandlers(
          { noteId: input.canvasNoteId, ...noteEdit },
          input.noteEditLabels ?? {
            applyEdit: fallbackLabel('notes.edit_apply', '应用到笔记'),
            dismissSuggestion: fallbackLabel('notes.edit_dismiss', '忽略建议'),
          },
        ),
      );
    }
  }

  const hasResearchBlocks = intentHasResearchBlocks(input.intent);
  const needsResearchHandlers =
    hasResearchBlocks && RESEARCH_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsResearchHandlers) {
    Object.assign(
      handlers,
      createResearchBriefingActionHandlers(
        {
          getReportBody: () => extractResearchReportBody(input.intent) ?? '',
          getExportMarkdown: () =>
            buildResearchExportMarkdownFromIntent(
              input.intent,
              input.intent.meta?.title,
              input.researchExportLabels,
            ),
          getIntent: () => input.intent,
        },
        input.researchLabels ?? {
          copyReport: fallbackLabel('research.actions.copy_report', '复制报告'),
          exportPlan: fallbackLabel('research.actions.export_plan', '导出计划'),
          exportIntent: fallbackLabel('research.actions.export_intent', '导出全部意图'),
        },
        input.intentExportLabels,
      ),
    );
  }

  const needsCopyIntent = COPY_INTENT_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsCopyIntent) {
    Object.assign(
      handlers,
      createCopyIntentActionHandlers(
        input.intent,
        input.copyIntentLabels ?? {
          copyIntent: fallbackLabel('action.copy_intent', '复制意图'),
        },
      ),
    );
  }

  const needsCopyBlock = COPY_BLOCK_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsCopyBlock) {
    Object.assign(
      handlers,
      createCopyBlockActionHandlers(
        input.intent,
        input.copyBlockLabels ?? {
          copyBlock: fallbackLabel('action.copy_block', '复制该组件'),
        },
      ),
    );
  }

  // 只读「打开已有资源」导航：目标从组合 action id 强校验反解。信任面与
  // Markdown 内联引用 [PDF@id:3] 一致——模型只能点名既有资源，导航本身走
  // DSTU_OPEN_NOTE / pdf-ref:open 既有只读契约，无 save/create 副作用；
  // 形状不符的 id 反解为 null，不注册 → 注册表安全模式下按钮不渲染。
  const openNoteTargets: OpenNoteActionInput[] = [];
  const openPdfPageTargets: OpenPdfPageActionInput[] = [];
  for (const id of actionIds) {
    const parsed = parseOpenResourceActionId(id);
    if (!parsed) continue;
    if (parsed.kind === 'note') {
      openNoteTargets.push({
        noteId: parsed.noteId,
        label: fallbackLabel('action.open_note', '打开笔记'),
      });
    } else {
      openPdfPageTargets.push({
        sourceId: parsed.sourceId,
        pageNumber: parsed.pageNumber,
        label: String(
          i18n.t('generativeUi:action.open_pdf_page', {
            defaultValue: '打开 PDF 第 {{page}} 页',
            page: parsed.pageNumber,
          }),
        ),
      });
    }
  }
  if (openNoteTargets.length > 0 || openPdfPageTargets.length > 0) {
    Object.assign(
      handlers,
      createOpenResourceActionHandlers({
        notes: openNoteTargets,
        pdfPages: openPdfPageTargets,
      }),
    );
  }

  if (
    actionIds.has(EXPORT_INTENT_ACTION_ID) &&
    !lookupGenerativeActionHandler(handlers, EXPORT_INTENT_ACTION_ID)
  ) {
    Object.assign(
      handlers,
      createExportIntentActionHandlers(
        input.intent,
        {
          exportMarkdown:
            input.researchLabels?.exportIntent ??
            fallbackLabel('research.actions.export_intent', '导出全部意图'),
        },
        input.intentExportLabels,
      ),
    );
  }

  return withGenerativeActionInstrumentation(handlers);
}
