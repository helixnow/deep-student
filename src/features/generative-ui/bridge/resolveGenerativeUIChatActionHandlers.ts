/**
 * Chat generative_ui 块 — 按 modeState + toolInput 解析 actionHandlers
 */

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
import {
  createFlashcardSaveActionHandlers,
  type FlashcardActionLabels,
  type FlashcardSaveContext,
} from '../handlers/flashcardActionHandlers';
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

export const NOTE_EDIT_ACTION_IDS = ['apply-note-edit', 'dismiss-note-suggestion'] as const;
export const FLASHCARD_ACTION_IDS = ['save-to-library'] as const;
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
  flashcardLabels?: FlashcardActionLabels;
  flashcardContext?: FlashcardSaveContext;
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
            applyEdit: '应用到笔记',
            dismissSuggestion: '忽略建议',
          },
        ),
      );
    }
  }

  const needsFlashcardHandlers = FLASHCARD_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsFlashcardHandlers) {
    Object.assign(
      handlers,
      createFlashcardSaveActionHandlers(
        input.intent,
        input.flashcardContext ?? {},
        input.flashcardLabels ?? { saveToLibrary: '保存到闪卡库' },
      ),
    );
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
          copyReport: '复制报告',
          exportPlan: '导出计划',
          exportIntent: '导出全部意图',
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
        input.copyIntentLabels ?? { copyIntent: '复制意图' },
      ),
    );
  }

  const needsCopyBlock = COPY_BLOCK_ACTION_IDS.some((id) => actionIds.has(id));
  if (needsCopyBlock) {
    Object.assign(
      handlers,
      createCopyBlockActionHandlers(
        input.intent,
        input.copyBlockLabels ?? { copyBlock: '复制该组件' },
      ),
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
          exportMarkdown: input.researchLabels?.exportIntent ?? '导出全部意图',
        },
        input.intentExportLabels,
      ),
    );
  }

  return withGenerativeActionInstrumentation(handlers);
}
