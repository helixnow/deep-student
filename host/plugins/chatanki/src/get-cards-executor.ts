// Rust: chatanki_executor.rs:2333–2465 `chatanki_get_cards` handler.
// Read-scope preflight + paged snapshot + L15 review states; the projection is
// `convert_card_for_tool` with field-limit soft warnings.
import type {
  ChatAnkiToolExecutor, CustomAnkiTemplate, FieldExtractionRule, ToolCall,
  ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { ChatAnkiReviewStateError } from '../api.ts';
import { resolveChatankiReadSession, STATUS_NOT_FOUND } from './card-access.ts';
import { parseChatAnkiGetCardsArgs, selectChatankiCardsPage } from './executor-args.ts';
import {
  FIELD_LIMIT_HINT, chatankiSensitivityForCall, computeFieldLimitWarnings,
} from './executor-helpers.ts';
import { attachReviewStates } from './library-output.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import {
  beginChatAnkiToolCall,
  finishChatAnkiAppFailure,
  finishChatAnkiFailure as finishFailure, finishChatAnkiSuccess as finishSuccess,
  publishedAppError,
} from './result.ts';
import { rustTrim } from '../../../platform/util/text.ts';

type TemplateRuleLookup = (templateId: string) => Record<string, FieldExtractionRule> | null;

function templateRuleLookup(ctx: ToolExecutionContext): TemplateRuleLookup | null {
  const db = ctx.mainDb ?? ctx.ankiDb ?? null;
  const lookup = ctx.templateLookup ?? null;
  if (db !== null) {
    return (templateId) => {
      const template: CustomAnkiTemplate | null = db.getCustomTemplateById(templateId);
      return template?.field_extraction_rules ?? null;
    };
  }
  if (lookup !== null) {
    return (templateId) => {
      const template: CustomAnkiTemplate | null = lookup.getCustomTemplateById(templateId);
      return template?.field_extraction_rules ?? null;
    };
  }
  return null;
}

/** chatanki_executor.rs:11654–11672 `attach_field_limit_warnings`. */
export function attachFieldLimitWarnings(
  output: Record<string, unknown>,
  ctx: ToolExecutionContext,
  cards: readonly Record<string, unknown>[],
): void {
  const lookup = templateRuleLookup(ctx);
  if (lookup === null) return;
  const { warnings, total } = computeFieldLimitWarnings(cards, lookup);
  if (total === 0) return;
  output.fieldLimitWarnings = warnings;
  output.fieldLimitWarningsTotal = total;
  output.fieldLimitHint = FIELD_LIMIT_HINT;
}

/** chatanki_executor.rs:2333–2465. */
export async function executeChatAnkiGetCards(
  call: ToolCall, ctx: ToolExecutionContext,
): Promise<ToolResultInfo> {
  const startedAt = performance.now();
  let args;
  try { args = parseChatAnkiGetCardsArgs(call.arguments); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Invalid chatanki_get_cards arguments: ${errorText(caught)}`);
  }
  const documentId = rustTrim(args.documentId);
  if (documentId.length === 0) {
    return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.documentIdRequired');
  }
  const repo = ctx.cards ?? null;
  if (repo === null) {
    return finishFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.databaseUnavailable');
  }

  const page = Math.max(args.page ?? 1, 1);
  const pageSize = Math.min(Math.max(args.pageSize ?? 20, 1), 50);

  let readSession: string;
  try { readSession = resolveChatankiReadSession(repo, documentId, ctx.sessionId, ctx.warn, ctx.info); }
  catch (caught) { return finishFailure(call, ctx, startedAt, errorText(caught)); }

  let snapshot;
  try { snapshot = repo.getCardsForDocumentForSession(documentId, readSession); }
  catch (caught) {
    return finishFailure(call, ctx, startedAt,
      `Failed to load cards for document: ${errorText(caught)}`);
  }
  if (snapshot === null) return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);

  const filter = args.filter;
  const selection = selectChatankiCardsPage(snapshot, filter, page, pageSize);
  const pageCardIds = selection.items
    .map((card) => card.id)
    .filter((id): id is string => typeof id === 'string');

  const reviewStates = ctx.reviewStates ?? null;
  if (reviewStates === null) {
    return finishFailure(call, ctx, startedAt,
      'chatanki_get_cards requires the L15 review-state service (getReviewStatesForSession)');
  }
  let states;
  try { states = reviewStates.getReviewStatesForSession(pageCardIds, readSession); }
  catch (caught) {
    if (caught instanceof ChatAnkiReviewStateError && caught.type === 'NotFound') {
      return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
    }
    const appError = publishedAppError(caught);
    if (appError !== null) {
      if (appError.error_type === 'NotFound') {
        return finishFailure(call, ctx, startedAt, STATUS_NOT_FOUND);
      }
      // chatanki_executor.rs:2406–2420: non-NotFound AppErrors keep the full
      // structured payload instead of being flattened into a string.
      return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
    }
    return finishFailure(call, ctx, startedAt,
      `Failed to load review states: ${errorText(caught)}`);
  }
  attachReviewStates(selection.items, states);

  const output: Record<string, unknown> = {
    status: 'ok',
    documentId,
    total: selection.total,
    page,
    pageSize,
    filter,
    cards: selection.items,
    hiddenOverLimitCount: ctx.hiddenOverLimitCount?.(readSession, documentId) ?? 0,
  };
  attachFieldLimitWarnings(output, ctx, selection.items);
  return finishSuccess(call, ctx, startedAt, output);
}

export class ChatAnkiGetCardsExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_get_cards';
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiGetCardsExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    beginChatAnkiToolCall(call, ctx);
    return executeChatAnkiGetCards(call, ctx);
  }
}
