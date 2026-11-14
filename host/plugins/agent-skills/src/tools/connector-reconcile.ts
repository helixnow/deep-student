/**
 * Startup reconciliation for the connector operation ledger, split out of
 * `connector-executor.ts` (quality.md §2.4 keeps modules under ~800 lines).
 *
 * Converges leftover `submitting` rows to `outcome_unknown`, then trusts only a
 * definitive provider lookup. Lookup failures always leave the row unknown;
 * they never fabricate a terminal state.
 */
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import { now } from '../../../../platform/time/index.ts';
import {
  listPendingConnectorReconcile, markConnectorCommitted, markConnectorFailed,
  reconcileSubmittingOnStartup,
} from '../../repository/connector-ledger.ts';
import {
  CONNECTOR_REGISTRY_KEY, WEBHOOK_PROVIDER_KIND, ProviderError, errorText,
  parseRegistry,
  type ConnectorConfig, type ConnectorLogger, type ConnectorProvider, type ConnectorSettings,
  type ProviderOutcome, type WebhookConfig,
} from './connector-executor.ts';

export interface ReconcileReport {
  convergedSubmitting: number;
  lookupCommitted: number;
  lookupNeverSubmitted: number;
  stillUnknown: number;
  skippedNoLookup: number;
}

/**
 * Startup lookup reconciliation: converge leftover submitting rows to
 * outcome_unknown, then trust only a definitive provider lookup. Lookup
 * failures always leave the row unknown; they never fabricate a terminal state.
 */
export async function reconcileConnectorOperationsWithLookup(
  mainDb: ConnectorSettings,
  chatV2Db: SqlExecutor,
  createProvider: (config: WebhookConfig, db: ConnectorSettings) => ConnectorProvider,
  logger: ConnectorLogger = {},
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    convergedSubmitting: reconcileSubmittingOnStartup(chatV2Db),
    lookupCommitted: 0,
    lookupNeverSubmitted: 0,
    stillUnknown: 0,
    skippedNoLookup: 0,
  };
  const pending = listPendingConnectorReconcile(chatV2Db);
  if (pending.length === 0) return report;
  let registry: ConnectorConfig[];
  try { registry = parseRegistry(mainDb.getSecret(CONNECTOR_REGISTRY_KEY)); }
  catch (error) {
    throw new Error(`failed to read connector registry for reconcile: ${errorText(error)}`);
  }

  for (const row of pending) {
    const connector = registry.find(
      entry => entry.id === row.providerId && entry.provider === WEBHOOK_PROVIDER_KIND,
    );
    const webhook = connector?.webhook;
    if (webhook === undefined) {
      report.skippedNoLookup += 1;
      logger.info?.(
        `[connector-reconcile] operation ${row.operationId} (provider '${row.providerId}') `
        + 'skipped: no provider lookup capability',
      );
      continue;
    }
    let provider: ConnectorProvider;
    try { provider = createProvider(webhook, mainDb); }
    catch (error) {
      report.stillUnknown += 1;
      logger.warn?.(
        `[connector-reconcile] operation ${row.operationId} (provider '${row.providerId}') `
        + `cannot build webhook provider (${errorText(error)}); left as outcome_unknown`,
      );
      continue;
    }
    let outcome: ProviderOutcome | null;
    try { outcome = await provider.lookup(row.idempotencyKey); }
    catch (error) {
      const providerError = error instanceof ProviderError
        ? error : ProviderError.unknown(errorText(error));
      report.stillUnknown += 1;
      logger.warn?.(
        `[connector-reconcile] operation ${row.operationId} lookup failed `
        + `(${providerError.kind}: ${providerError.message}); left as outcome_unknown`,
      );
      continue;
    }
    if (outcome !== null) {
      const evidence = JSON.stringify({
        reconciled_via: 'provider_lookup',
        provider: provider.name(),
        operation_id: row.operationId,
        external_operation_id: outcome.externalOperationId,
        receipt: outcome.receipt,
      });
      try {
        markConnectorCommitted(
          chatV2Db, row.operationId, now().rfc3339, outcome.externalOperationId, evidence,
        );
        report.lookupCommitted += 1;
        logger.info?.(
          `[connector-reconcile] operation ${row.operationId} reconciled to committed via `
          + `provider lookup (external id present: ${outcome.externalOperationId !== null})`,
        );
      } catch (error) {
        report.stillUnknown += 1;
        logger.warn?.(
          `[connector-reconcile] operation ${row.operationId} lookup hit but commit failed: `
          + errorText(error),
        );
      }
      continue;
    }
    const note = `never_submitted: provider '${provider.name()}' has no record of this `
      + 'idempotency key';
    try {
      markConnectorFailed(chatV2Db, row.operationId, now().rfc3339, note);
      report.lookupNeverSubmitted += 1;
      logger.info?.(`[connector-reconcile] operation ${row.operationId} reconciled to failed: ${note}`);
    } catch (error) {
      report.stillUnknown += 1;
      logger.warn?.(
        `[connector-reconcile] operation ${row.operationId} lookup miss but fail-mark failed: `
        + errorText(error),
      );
    }
  }
  return report;
}
