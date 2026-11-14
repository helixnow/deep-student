import { describe, expect, it } from 'vitest';
import {
  buildTaskAuditManifest, canHandleTaskAuditTool, missingRequestedLayers,
  taskAuditSensitivityLevel, type TaskObjectHandleLike,
} from '../src/task-audit.ts';

function handle(id: string): TaskObjectHandleLike {
  return {
    schemaVersion: 1,
    handleId: id,
    kind: 'file',
    displayName: 'report.txt',
    mediaType: 'text/plain',
    sizeBytes: 5,
    sha256: 'a'.repeat(64),
    locator: null,
    providerRef: null,
    acl: null,
    capabilities: {},
    expiresAt: null,
    provenance: {
      source: 'attachment',
      sourceUri: null,
      server: null,
      tool: null,
      derivedFrom: [],
      observedAt: '2026-07-19T00:00:00Z',
    },
  };
}

describe('task_audit_executor.rs manifest export', () => {
  it('col_08_export_aggregates_governance_fields_and_redacts_secrets', () => {
    const value = buildTaskAuditManifest({
      taskId: 'task-1',
      objectHandles: [handle('input-1')],
      toolCalls: [{
        callId: 'call-1',
        toolName: 'connector_operation_commit',
        arguments: { apiKey: 'secret', safe: 'visible' },
        resultHash: 'b'.repeat(64),
      }],
      approvals: [{ approvalId: 'approval-1', scopeHash: 'c'.repeat(64), decision: 'approved' }],
      outputs: [{ objectHandleId: 'output-1', sha256: 'd'.repeat(64) }],
      connectorTargets: [{
        operationId: 'op-1',
        recipients: ['person@example.com'],
        aclPrincipals: ['team-1'],
      }],
      rolePackVersion: 'legal-review@1.0.0',
      changeCoverage: { changesRecorded: true, rollbackAvailable: true, rollbackVerified: true },
    });
    const toolCalls = value.toolCalls as Array<{ arguments: Record<string, unknown> }>;
    expect(toolCalls[0]!.arguments.apiKey).toBe('[REDACTED]');
    expect(toolCalls[0]!.arguments.safe).toBe('visible');
    const targets = value.connectorTargets as Array<{ recipients: string[] }>;
    expect(targets[0]!.recipients[0]).toBe('person@example.com');
    expect(value.rolePackVersion).toBe('legal-review@1.0.0');
    expect(value.evidenceOrigin).toBe('caller_supplied');
    expect(value.authoritative).toBe(false);
    expect(value.coverageComplete).toBe(false);
    expect(value.missingCoverage as string[]).toContain('backend_session_ledger');
  });

  it('col_06_missing_requested_layer_is_never_reported_complete', () => {
    const missing = missingRequestedLayers(['source', 'embedding'], ['source']);
    expect(missing).toEqual(['embedding']);
  });

  it('col_06_forget_is_high_sensitivity_and_audit_export_is_serialized', () => {
    expect(taskAuditSensitivityLevel('builtin-lineage_forget')).toBe('High');
    expect(taskAuditSensitivityLevel('builtin-task_audit_export')).toBe('Medium');
    expect(canHandleTaskAuditTool('lineage_forget')).toBe(true);
    expect(canHandleTaskAuditTool('builtin-task_audit_export')).toBe(true);
  });
});
