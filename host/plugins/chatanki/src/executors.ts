// The production executor roster, shared by plugin wiring and public metadata consumers.
import type { ChatAnkiToolExecutor } from '../api.ts';
import { ChatAnkiApkgExecutor } from './apkg-executor.ts';
import { ChatAnkiCardBatchExecutor } from './card-batch-executor.ts';
import { ChatAnkiExecutor } from './chatanki-executor.ts';
import { ChatAnkiControlExecutor } from './control-executor.ts';
import { FsrsSettingsExecutor } from './fsrs-settings-executor.ts';
import { ChatAnkiGetCardsExecutor } from './get-cards-executor.ts';
import { ChatAnkiLibraryListExecutor } from './library-list-executor.ts';
import { ChatAnkiLibraryMutationExecutor } from './library-mutation-executor.ts';
import { ChatAnkiLibraryReviewExecutor } from './library-review-executor.ts';
import { ChatAnkiMutationExecutor } from './mutation-executor.ts';
import { ChatAnkiRetemplateExecutor } from './retemplate-executor.ts';
import { ChatAnkiReviewExecutor } from './review-executor.ts';
import { ChatAnkiStartExecutor } from './start-executor.ts';
import { ChatAnkiStatusExecutor } from './status-executor.ts';
import { ChatAnkiSyncExecutor } from './sync-executor.ts';
import { TemplateDesignerExecutor } from './template-executor.ts';
import { ChatAnkiWaitExecutor } from './wait-executor.ts';

/**
 * Owner capabilities that decide whether a tool is claimed at all. They are probed on every
 * `canHandle`, so the tool face follows the live host; an absent probe means the capability is missing.
 */
export interface ChatAnkiExecutorCapabilities {
  /** L16 publishes `getAnkiAgentLibraryCard`, the same-row read update/delete_library_card require. */
  libraryCardRead?: () => boolean;
  /** L16 publishes `anki.pipeline` (pause/resume/cancel/retry) for `chatanki_control`. */
  documentPipeline?: () => boolean;
  /** L16 publishes the AnkiConnect sync + export receipt facade for `chatanki_sync`. */
  ankiConnectSync?: () => boolean;
  /** L16 `anki.pipeline` also publishes `startDocumentProcessingWithId`/`cancelStreaming` for `chatanki_start`. */
  generationPipeline?: () => boolean;
  /** L04 history, L02 raw prompt and (when the VFS database exists) the full VFS read set for `chatanki_run`. */
  runInput?: () => boolean;
}

/**
 * Constructs the same real executors used by `chatankiTools` (no host services
 * are needed for metadata). Unlike Rust's single ChatAnkiToolExecutor, TS
 * splits get_cards/status/mutations into separate handlers; consumers select
 * the first executor whose canHandle(toolName) returns true.
 */
export function createChatAnkiExecutors(capabilities: ChatAnkiExecutorCapabilities = {}): readonly ChatAnkiToolExecutor[] {
  return [
    new FsrsSettingsExecutor(), new TemplateDesignerExecutor(), new ChatAnkiExecutor(),
    new ChatAnkiMutationExecutor(), new ChatAnkiCardBatchExecutor(), new ChatAnkiRetemplateExecutor(),
    new ChatAnkiReviewExecutor(), new ChatAnkiGetCardsExecutor(), new ChatAnkiLibraryListExecutor(),
    new ChatAnkiStatusExecutor(), new ChatAnkiApkgExecutor(), new ChatAnkiLibraryReviewExecutor(),
    new ChatAnkiLibraryMutationExecutor(capabilities.libraryCardRead ?? (() => false)), new ChatAnkiWaitExecutor(),
    new ChatAnkiControlExecutor(capabilities.documentPipeline ?? (() => false)),
    new ChatAnkiSyncExecutor(capabilities.ankiConnectSync ?? (() => false)),
    new ChatAnkiStartExecutor(capabilities.generationPipeline ?? (() => false), capabilities.runInput ?? (() => false)),
  ];
}

/** Rust registers these two as their own roster entries; every other chatanki tool is `ChatAnkiToolExecutor`'s. */
const OWN_ROSTER_ENTRIES = new Set(['FsrsSettingsExecutor', 'TemplateDesignerExecutor']);

/**
 * The registration units for `agentTools`: the split handlers are folded back into one
 * `ChatAnkiToolExecutor` (first `canHandle` match, same order as `createChatAnkiExecutors`), so they
 * occupy that roster slot. Registered under their own names they would sort after every roster entry
 * (`orderExecutorsByRoster`), and a roster executor inserted later could claim `chatanki_*` first.
 */
export function rosterChatAnkiExecutors(executors: readonly ChatAnkiToolExecutor[]): readonly ChatAnkiToolExecutor[] {
  const handlers = executors.filter((executor) => !OWN_ROSTER_ENTRIES.has(executor.name()));
  const primary = handlers.find((executor) => executor.name() === 'ChatAnkiToolExecutor') ?? handlers[0];
  if (primary === undefined) return executors;
  const match = (toolName: string) => handlers.find((executor) => executor.canHandle(toolName));
  const handler = (toolName: string) => match(toolName) ?? primary;
  const unit: ChatAnkiToolExecutor = {
    name: () => 'ChatAnkiToolExecutor',
    canHandle: (toolName) => match(toolName) !== undefined,
    sensitivityLevel: (toolName) => handler(toolName).sensitivityLevel(toolName),
    sensitivityLevelForCall: (toolName, args) => {
      const executor = handler(toolName);
      return executor.sensitivityLevelForCall?.(toolName, args) ?? executor.sensitivityLevel(toolName);
    },
    hasDynamicSensitivity: (toolName) => handler(toolName).hasDynamicSensitivity?.(toolName) ?? false,
    concurrencyClass: (toolName) => handler(toolName).concurrencyClass(toolName),
    execute: (call, context) => handler(call.name).execute(call, context),
  };
  return [...executors.filter((executor) => OWN_ROSTER_ENTRIES.has(executor.name())), unit];
}
