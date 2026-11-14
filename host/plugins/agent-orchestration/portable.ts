/**
 * Node-free subset of `api.ts` for consumers that must also load on mobile (chat's closure).
 * Every export is the same value `api.ts` publishes; tests/portability.test.ts keeps the runtime closure free of
 * Node-specific deps. Persona files and the todo repository (`storage/api.ts`) stay desktop-only in `api.ts`.
 */
export { isAttemptCompletion } from './src/attempt-completion.ts';
export { todoCompletedCount, todoIsAllDone, todoTotalCount } from './src/todo.ts';
export { headlessToolSchemas, trustedAutomationError } from './src/headless.ts';
/** `api.ts` 的别名（`isTrustedAutomationPreauthorized as trustedAutomationPreauthorized`）。 */
export { isTrustedAutomationPreauthorized as trustedAutomationPreauthorized } from './src/headless.ts';
export { loadPersistedTodoListWithConn, restoreTodoListFromDbWithConn } from './repository/todo.ts';
export {
  atomicWrite, resolvePersonaPath, validatePersonaContent, withCustomAgentFileLock,
} from './src/custom-agent.ts';
export type { PersonaContentSummary } from './src/custom-agent.ts';
export type { PersistedTodoList } from './repository/todo.ts';
export {
  DEFAULT_PACK_TIMEOUT_SECS, MAX_CONCURRENCY, MAX_SUB_TOOLS, TOOL_PACK_EXECUTOR_NAME, TOOL_PACK_TOOL_NAME,
  canHandleToolPack,
} from './src/tool-pack.ts';
export type { ToolPackContext } from './src/tool-pack.ts';
