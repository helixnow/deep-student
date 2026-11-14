/**
 * `streaming_anki_service.rs` 的迁移入口。
 *
 * 质量规范 §2.4：原 1716 行单文件已按职责拆分：
 * - `streaming-anki-protocol.ts`：常量、模型包装 token、统计与事件载荷
 * - `streaming-anki-templates.ts`：模板标识解析
 * - `streaming-anki-fields.ts`：可读文本、占位符、字段描述与校验
 * - `streaming-anki-prompt.ts`：提示词构建
 * - `streaming-anki-buffer.ts`：流式切卡状态机
 * - `streaming-anki-cancel.ts`：取消通道与依赖接口
 * - `streaming-anki-errors.ts`：错误形状与遮挡辅助
 * - `streaming-anki-runtime.ts`：`StreamingAnkiService` 状态机
 *
 * 本文件只做稳定导出面的接线，不承载业务逻辑。
 */
export {
  BROKEN_DELIMITER_TAIL,
  CARDS_WRAPPER_KEY,
  CARD_DELIMITER,
  buildResponseFormat,
  isStructuredProtocol,
  resolveOutputProtocol,
  stripWrapperPrefix,
  qaPassEnabled as structuredQaPassEnabled,
  structuredOutputOptionsFromOptionsJson,
  type SchemaCapability,
} from './anki-protocol.ts';
export { defaultCriticSummary } from './anki-critic-prompt.ts';
export {
  CANCELLED_BY_USER_MSG,
  CARD_BUFFER_HARD_LIMIT,
  ERR_KEYWORD_TIMEOUT,
  ERR_KEYWORD_TRUNCATED,
  ERROR_CARD_RAW_PREVIEW_CHARS,
  LATEX_RULES,
  MODEL_SPECIAL_TOKENS,
  QA_FLAGS_FIELD,
  RETRY_ASSIGNMENT_MARK,
  UNREADABLE_FRAGMENT_MSG,
  buildCriticSummaryEvent,
  buildTaskCompletedEvent,
  containsOnlyModelSpecialTokens,
  defaultStreamStats,
  errorContentIsRepairable,
  statsHasAnySignal,
  statsHasWarnings,
  stripModelSpecialTokens,
  type StreamStats,
} from './streaming-anki-protocol.ts';
export {
  formatTemplateIdentifierHelp,
  normalizeTemplateIdentifier,
  resolveTemplateIdCandidate,
} from './streaming-anki-templates.ts';
export {
  compactOutputBudget,
  deckTag,
  describePromptField,
  errorCardContent,
  extractReadableText,
  fieldTypeName,
  findRule,
  isPlaceholderCard,
  jsonFragmentBalanced,
  validateFieldAgainstRule,
  type FieldViolation,
} from './streaming-anki-fields.ts';
export { buildPrompt, type PromptPayload } from './streaming-anki-prompt.ts';
export {
  checkBufferHardLimit,
  extractCardFromBufferImpl,
  type ExtractCardResult,
  type ResidualCardPayload,
} from './streaming-anki-buffer.ts';
export {
  cancelStreaming,
  clearCancelSender,
  isStreaming,
  registerCancellation,
  type StreamingAnkiDeps,
} from './streaming-anki-cancel.ts';
export { DatabaseError, ValidationError } from './streaming-anki-errors.ts';
export { StreamingAnkiService } from './streaming-anki-runtime.ts';
