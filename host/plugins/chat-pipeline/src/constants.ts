/**
 * pipeline/constants.rs — pipeline-wide limits and default budgets.
 */

/**
 * Effective tool-loop round cap.
 *
 * `null`/`0` means unlimited (the default for long-running agents); any
 * positive value is clamped to 1..100.
 */
export function effectiveMaxToolRounds(
  maxToolRecursion: number | null | undefined,
): number | null {
  if (maxToolRecursion === null || maxToolRecursion === undefined
    || maxToolRecursion <= 0) return null;
  return Math.min(Math.max(Math.trunc(maxToolRecursion), 1), 100);
}

/** Default tool timeout in milliseconds (30s). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
/** Default retrieval top-K. */
export const DEFAULT_RAG_TOP_K = 5;
/** Default graph retrieval top-K. */
export const DEFAULT_GRAPH_TOP_K = 10;
/** Default multimodal retrieval top-K. */
export const DEFAULT_MULTIMODAL_TOP_K = 10;
/** History context limit when the request does not set one. */
export const DEFAULT_CONTEXT_LIMIT = 20;
/** Streaming idle timeout (10 minutes without any chunk). */
export const LLM_STREAM_TIMEOUT_SECS = 600;
/** Absolute cap for one streaming call (2 hours). */
export const LLM_STREAM_MAX_TOTAL_SECS = 7_200;
/** Non-streaming call timeout used for summaries (2 minutes). */
export const LLM_NON_STREAM_TIMEOUT_SECS = 120;

/**
 * constants.rs `is_config_id_format`: `builtin-*` or a 36-char 8-4-4-4-12
 * ASCII-hex UUID (exactly four hyphens). Everything else is a display name.
 */
export function isConfigIdFormat(id: string): boolean {
  if (id === '') return false;
  if (id.startsWith('builtin-')) return true;
  return id.length === 36
    && [...id].filter(char => char === '-').length === 4
    && [...id].every(char => char === '-' || /[0-9a-fA-F]/.test(char));
}

/** helpers.rs filter_retrieval_results defaults (constants.rs:101-105). */
export const RETRIEVAL_MIN_SCORE = 0.3;
export const RETRIEVAL_RELATIVE_THRESHOLD = 0.5;
