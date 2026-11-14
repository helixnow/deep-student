/**
 * 生成任务结束后的 critic 质检（`dstu-anki/src/streaming_anki_service.rs` critic 段）：
 * 卡片存储与路由 LLM 适配，摘要事件发给前端。
 */
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  LlmAnkiRouting,
  LlmRawPrompt,
  RoleDecision as LlmRoleDecision,
} from '../../llm/api.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { decodeAnkiCardRow } from './anki-cards.ts';
import { listCardsForDocument, listCardsForTask, updateAnkiCardIfVersionForLibrary } from '../repository/anki-cards.ts';
import type { AnkiLibraryCardRow } from './library.ts';
import type { AnkiLogger } from './logger.ts';
import { buildCriticSummaryEvent, type StreamStats } from './streaming-anki.ts';
import {
  defaultCriticLogger,
  collectGoldReferences,
  runCriticPass,
  type AnkiCriticLlm,
  type AnkiLibraryCardRecord,
  type CriticCardStore,
  type RoleDecision,
} from './anki-critic.ts';
import { criticConfigFromOptions, criticEnabled, criticOptionsFromOptionsJson } from './anki-critic-prompt.ts';
import { defaultGoldSetMining } from './anki-gold-set.ts';
import type { AnkiEventWindow } from './enhanced-service.ts';

import { generationErrorMessage } from './generation-service.ts';

/** critic 需要的生成服务依赖（`AnkiGenerationService` 实例满足此接口）。 */
export interface GenerationCriticDeps {
  readonly db: DatabaseHandle;
  readonly logger: AnkiLogger;
  readonly routing: LlmAnkiRouting | null;
  readonly rawPrompt: LlmRawPrompt | null;
}

/** L02 wire 风格（camelCase）→ L16 critic 内部/Rust 风格（snake_case）。 */
function toCriticDecision(decision: LlmRoleDecision): RoleDecision {
  return {
    role: decision.role,
    config_id: decision.configId,
    model: decision.model,
    slot: decision.slot === 'ankiCard'
      ? 'anki_card'
      : decision.slot === 'mainModel'
        ? 'main_model'
        : 'vision',
    degraded: decision.degraded,
    is_multimodal: decision.isMultimodal,
    reason: decision.reason,
  };
}

function toLlmDecision(decision: RoleDecision): LlmRoleDecision {
  return {
    role: decision.role,
    configId: decision.config_id,
    model: decision.model,
    slot: decision.slot === 'anki_card'
      ? 'ankiCard'
      : decision.slot === 'main_model'
        ? 'mainModel'
        : 'vision',
    degraded: decision.degraded,
    isMultimodal: decision.is_multimodal,
    reason: decision.reason,
  };
}

export async function runGenerationCritic(
  deps: GenerationCriticDeps,
  task: DocumentTask,
  stats: StreamStats,
  window: AnkiEventWindow,
): Promise<void> {
  const criticOptions = criticOptionsFromOptionsJson(task.anki_generation_options_json);
  if (!criticEnabled(criticOptions) || stats.card_count <= 0) return;
  const config = criticConfigFromOptions(criticOptions);
  const goldSet = defaultGoldSetMining();
  const store = criticCardStore(deps);
  const references = collectGoldReferences(store, task, config, goldSet, defaultCriticLogger);
  const summary = await runCriticPass(
    {
      db: store,
      llm: criticLlm(deps),
      goldSet,
      logger: defaultCriticLogger,
    },
    task,
    references,
    config,
  );
  try {
    window.emit(
      'anki_generation_event',
      buildCriticSummaryEvent(task.id, task.document_id, summary),
    );
  } catch (error) {
    deps.logger.error(`发送 critic 摘要事件失败: ${generationErrorMessage(error)}`);
  }
}

function criticCardStore(deps: GenerationCriticDeps): CriticCardStore {
  const toCard = (row: ReturnType<typeof listCardsForTask>[number]): AnkiCard =>
    decodeAnkiCardRow(row);
  const toRecord = (row: AnkiLibraryCardRow): AnkiLibraryCardRecord => ({
    library_card: { card: decodeAnkiCardRow(row) },
  });
  return {
    getCardsForTask: (taskId) => listCardsForTask(deps.db, taskId).map(toCard),
    getCardsForDocument: (documentId) =>
      listCardsForDocument(deps.db, documentId).map(toCard),
    updateAnkiCardIfVersionForLibrary: (scope, card, expectedUpdatedAt) => {
      void scope;
      const result = updateAnkiCardIfVersionForLibrary(
        deps.db,
        card,
        expectedUpdatedAt,
        Date.now(),
      );
      if (result.type === 'updated') {
        return { type: 'updated', current: toRecord(result.current) };
      }
      if (result.type === 'conflict') {
        return { type: 'conflict', current: toRecord(result.current) };
      }
      return { type: 'notFound' };
    },
  };
}

function criticLlm(deps: GenerationCriticDeps): AnkiCriticLlm {
  return {
    resolveAnkiRoleDecision: async (role, mode) => {
      if (deps.routing === null) return null;
      try {
        const decision = await deps.routing.resolveAnkiRoleDecision(role, mode);
        return decision === null ? null : toCriticDecision(decision);
      } catch (error) {
        deps.logger.debug(
          `[ANKI_ROUTING] 解析 ${role} 路由决策失败，回退旧路径: ${generationErrorMessage(error)}`,
        );
        return null;
      }
    },
    callAnkiRoutedRawPrompt: async (decision, task, prompt, images) => {
      if (deps.rawPrompt === null) {
        throw AppError.configuration('Anki critic 不可用：L02 未提供 llmRawPrompt 服务');
      }
      return deps.rawPrompt.callAnkiRoutedRawPrompt(
        decision === null ? null : toLlmDecision(decision),
        task,
        prompt,
        images,
      );
    },
  };
}
