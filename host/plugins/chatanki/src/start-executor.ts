// Rust: chatanki_executor.rs:6760–6815 `execute_start` (plain-text input, never VLM) and
// :6817–6899 `execute_run` (VfsRef input: session/VFS refs, optional content, forced route, VLM).
import type {
  ToolCall, ToolConcurrency, ToolExecutionContext, ToolResultInfo, ToolSensitivity, ChatAnkiToolExecutor,
} from '../api.ts';
import { parseChatAnkiRoute } from './chatanki-executor.ts';
import { errorText, stripToolNamespace } from './execution.ts';
import { chatankiSensitivityForCall } from './executor-helpers.ts';
import { beginChatAnkiToolCall, finishChatAnkiInlineFailure } from './result.ts';
import { parseChatAnkiRunArgs, parseChatAnkiStartArgs } from './run-args.ts';
import { startChatAnkiPipeline, type ChatAnkiPipelineClock, realPipelineClock } from './run-pipeline.ts';
import { rustTrim } from '../../../platform/util/text.ts';

export class ChatAnkiStartExecutor implements ChatAnkiToolExecutor {
  private readonly generationPublished: () => boolean;
  private readonly runInputPublished: () => boolean;
  private readonly clock: ChatAnkiPipelineClock;
  constructor(
    generationPublished: () => boolean, runInputPublished: () => boolean = () => false,
    clock: ChatAnkiPipelineClock = realPipelineClock,
  ) {
    this.generationPublished = generationPublished;
    this.runInputPublished = runInputPublished;
    this.clock = clock;
  }
  /** Claimed only while L16 publishes the generation run control (and, for run, the VfsRef reads). */
  canHandle(toolName: string): boolean {
    const tool = stripToolNamespace(toolName);
    if (tool === 'chatanki_start') return this.generationPublished();
    return tool === 'chatanki_run' && this.generationPublished() && this.runInputPublished();
  }
  sensitivityLevel(toolName: string): ToolSensitivity {
    return chatankiSensitivityForCall(toolName, {});
  }
  concurrencyClass(_toolName: string): ToolConcurrency { return 'serial'; }
  /** Split handler label; registration uses the folded `ChatAnkiToolExecutor` (`executors.ts`). */
  name(): string { return 'ChatAnkiStartExecutor'; }
  async execute(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    return stripToolNamespace(call.name) === 'chatanki_run' ? this.executeRun(call, ctx) : this.executeStart(call, ctx);
  }

  private async executeStart(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    let args;
    try { args = parseChatAnkiStartArgs(call.arguments); }
    catch (caught) {
      return finishChatAnkiInlineFailure(call, ctx, startedAt, `Invalid chatanki_start arguments: ${errorText(caught)}`);
    }
    return startChatAnkiPipeline(call, ctx, startedAt, {
      input: { kind: 'content', content: args.content ?? '' },
      goal: args.goal,
      deckName: args.deckName,
      noteType: args.noteType,
      templateMode: args.templateMode,
      templateId: args.templateId,
      templateIds: args.templateIds,
      debug: args.debug ?? false,
      forcedRoute: null,
      preferredResourceIds: null,
      maxCards: args.maxCards,
      extraRequirements: args.extraRequirements,
      tuning: {
        outputProtocol: args.outputProtocol,
        visualHint: null,
        contentFormat: args.contentFormat,
        enableQaPass: args.enableQaPass,
        enableCriticPass: args.enableCriticPass,
        enableFsrsFeedback: args.enableFsrsFeedback,
        maxImages: null,
        enablePreferenceMemory: args.enablePreferenceMemory,
      },
    }, this.clock);
  }

  private async executeRun(call: ToolCall, ctx: ToolExecutionContext): Promise<ToolResultInfo> {
    const startedAt = performance.now();
    beginChatAnkiToolCall(call, ctx);
    let args;
    try { args = parseChatAnkiRunArgs(call.arguments); }
    catch (caught) {
      return finishChatAnkiInlineFailure(call, ctx, startedAt, `Invalid chatanki_run arguments: ${errorText(caught)}`);
    }
    const ids: string[] = [];
    if (args.resourceId !== null && rustTrim(args.resourceId).length > 0) ids.push(args.resourceId);
    for (const id of args.resourceIds) {
      if (rustTrim(id).length === 0 || ids.includes(id)) continue;
      ids.push(id);
    }
    const visualHint = args.visualHint === null ? null : rustTrim(args.visualHint);
    return startChatAnkiPipeline(call, ctx, startedAt, {
      input: { kind: 'vfsRef', extraContent: args.content !== null && rustTrim(args.content).length > 0 ? args.content : null },
      goal: args.goal,
      deckName: args.deckName,
      noteType: args.noteType,
      templateMode: args.templateMode,
      templateId: args.templateId,
      templateIds: args.templateIds,
      debug: args.debug ?? false,
      forcedRoute: args.route === null ? null : parseChatAnkiRoute(args.route),
      preferredResourceIds: ids.length === 0 ? null : ids,
      maxCards: args.maxCards,
      extraRequirements: args.extraRequirements,
      tuning: {
        outputProtocol: args.outputProtocol,
        visualHint: visualHint === null || visualHint.length === 0 ? null : visualHint,
        contentFormat: args.contentFormat,
        enableQaPass: args.enableQaPass,
        enableCriticPass: args.enableCriticPass,
        enableFsrsFeedback: args.enableFsrsFeedback,
        maxImages: args.maxImages,
        enablePreferenceMemory: args.enablePreferenceMemory,
      },
    }, this.clock);
  }
}
