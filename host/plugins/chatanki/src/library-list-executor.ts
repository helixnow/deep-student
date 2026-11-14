// Rust chatanki_executor.rs:3562-3653: exact agent page -> L15 snapshots -> projection.
import type {
  ChatAnkiToolExecutor, ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity,
} from '../api.ts';
import { parseChatAnkiListLibraryCardsArgs } from './executor-args.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { convertLibraryRecordForTool } from './library-output.ts';
import {
  beginChatAnkiToolCall, finishChatAnkiAppFailure, finishChatAnkiFailure,
  finishChatAnkiSuccess, publishedAppError,
} from './result.ts';

export class ChatAnkiLibraryListExecutor implements ChatAnkiToolExecutor {
  canHandle(toolName: string): boolean {
    return stripToolNamespace(toolName) === 'chatanki_list_library_cards';
  }
  sensitivityLevel(_toolName: string): ToolSensitivity { return 'low'; }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  name(): string { return 'ChatAnkiLibraryListExecutor'; }

  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    let args;
    try { args = parseChatAnkiListLibraryCardsArgs(call.arguments); }
    catch (caught) {
      return finishChatAnkiFailure(call, ctx, startedAt,
        `Invalid chatanki_list_library_cards arguments: ${errorText(caught)}`);
    }
    const library = ctx.libraryCards ?? null;
    if (library === null) {
      return finishChatAnkiFailure(call, ctx, startedAt, 'blocks.ankiCards.errors.databaseUnavailable');
    }
    let page;
    try {
      page = library.listAnkiAgentLibraryPage({
        search: args.search, templateId: args.templateId,
        schedule: args.schedule, diagnostic: args.filter,
        // The owner defaults to 12. Rust's tool defaults to 20; always pass
        // both parser-normalized values, including when the caller omitted them.
        page: args.page, pageSize: args.pageSize,
      });
    } catch (caught) {
      return finishChatAnkiFailure(call, ctx, startedAt,
        `Failed to list Anki library cards: ${errorText(caught)}`);
    }

    // Preserve Rust's list-before-review error ordering, even for an empty page.
    const review = ctx.libraryReviewStates ?? null;
    if (review === null) {
      return finishChatAnkiFailure(call, ctx, startedAt,
        'chatanki_list_library_cards requires the L15 review-state service (getReviewStatesForLibrary)');
    }
    let states: ReturnType<typeof review.getReviewStatesForLibrary>;
    try {
      states = review.getReviewStatesForLibrary('agent', page.items.map((record) => record.libraryCard.id));
    } catch (caught) {
      const appError = publishedAppError(caught);
      if (appError !== null) return finishChatAnkiAppFailure(call, ctx, startedAt, appError);
      return finishChatAnkiFailure(call, ctx, startedAt, `Failed to load review states: ${errorText(caught)}`);
    }
    const byCardId = new Map(states.map((state) => [state.ankiCardId, state]));
    return finishChatAnkiSuccess(call, ctx, startedAt, {
      status: 'ok', total: page.total, page: page.page, pageSize: page.pageSize,
      search: args.search, templateId: args.templateId, schedule: args.schedule, filter: args.filter,
      cards: page.items.map((record) => convertLibraryRecordForTool(record, byCardId.get(record.libraryCard.id) ?? null)),
      ratingAvailableToAgent: false,
    });
  }
}
