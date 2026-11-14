/**
 * 自动化仓储的兼容聚合出口。
 *
 * 定义/schedule/心跳与 next_run_at 维护在 `automation-definitions.ts`，
 * 运行记录/租约/重试/通知回执在 `automation-runs.ts`，共享类型与 SQL 辅助
 * 在 `automation-model.ts`。保留本文件是为了不改变既有消费方的 import 路径。
 */
export {
  type ActionType,
  type HeadlessSessionMode,
  type AutomationDefinition,
  type AutomationCreateFields,
  type OptionalValue,
  type AutomationUpdateFields,
  type AutomationRunRecord,
  type ClaimedAutomationRun,
  HEARTBEAT_AUTOMATION_ID,
} from './automation-model.ts';

export {
  serializeSchedule, scheduleToListItem, parseScheduleJson, rowToAutomation,
  insertAutomation, generateAutomationId, automationVersionConflictError, createAutomation,
  loadAutomations, saveAutomations, setAutomationEnabled, updateAutomationFull, deleteAutomation,
  automationToListItem, automationToListObject, automationListResponse, effectiveAgentPrompt,
  automationToAgentListItem, updateAutomationLastRunAt, updateAutomationAgentSessionId,
  DEFAULT_HEARTBEAT_PROMPT, defaultHeartbeatDefinition, ensureHeartbeatInList, ensureHeartbeatAutomation,
  heartbeatIsSilent, scheduleSkewThreshold, initializeNextRun, repairSkewedNextRun,
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES, DEFAULT_MAX_RETRIES, DEFAULT_RETRY_BACKOFF_SECS, DEFAULT_TIMEOUT_SECS,
} from './automation-definitions.ts';

export {
  type PendingNotificationRun,
  type OnceFinalizeLogHooks,
  type OnceFinalizeHooks,
  type RunFinalizeOutcome,
  loadRunDeliveries, listPendingNotificationRuns, setNotificationRetryAt, automationRunIsRunning,
  setRunDeliveryMarker, rowToRun, listAutomationRuns, listAutomationRunsPage, loadAutomationRuns, pruneRunHistory,
  cancelAutomationRun, finalizeOnceAutomation, effectiveLeaseTimeoutSeconds, createManualRun,
  nextAfterClaim, claimScheduledRun, claimRetryRun, recoverStaleAutomationRuns, dueRetryIds,
  completeRun, retryOrFinishRun,
} from './automation-runs.ts';
