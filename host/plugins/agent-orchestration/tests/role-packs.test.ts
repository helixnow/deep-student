import { describe, expect, it } from 'vitest';
import {
  canHandleRolePackTool, executeRolePackRead, findRolePack, rolePackConcurrencyClass,
  rolePackProvenance, rolePackRegistry, rolePackSensitivityLevel, ROLE_PACK_EXECUTOR_NAME,
  ROLE_PACK_REGISTRY_REVISION, selectedRolePack, validateRolePackInput,
} from '../src/role-packs.ts';

describe('role_pack_executor.rs read-only discovery', () => {
  it('handles_only_read_only_role_pack_tools', () => {
    expect(canHandleRolePackTool('builtin-role_pack_list')).toBe(true);
    expect(canHandleRolePackTool('role_pack_get')).toBe(true);
    expect(canHandleRolePackTool('builtin-role_pack_validate')).toBe(true);
    expect(canHandleRolePackTool('role_pack_apply')).toBe(false);
    expect(rolePackSensitivityLevel()).toBe('Low');
    expect(rolePackConcurrencyClass()).toBe('ReadOnly');
    expect(ROLE_PACK_EXECUTOR_NAME).toBe('RolePackExecutor');
  });

  it('exact_version_selection_does_not_silently_upgrade', () => {
    const selected = selectedRolePack({ pack_id: 'finance-core', version: '1.0.0' });
    expect(selected.version).toBe('1.0.0');
  });

  it('list_applies_domain_and_deprecated_filters', () => {
    const finance = executeRolePackRead('role_pack_list', { domain: 'finance' }, 's', 'm');
    expect(finance.registryRevision).toBe(ROLE_PACK_REGISTRY_REVISION);
    const packs = finance.packs as Array<Record<string, unknown>>;
    expect(packs.map((pack) => pack.version)).toEqual(['1.0.0', '1.1.0']);
    expect(packs[0]!.workflowIds).toEqual(['invoice-reconcile']);

    const active = executeRolePackRead('builtin-role_pack_list', {
      domain: 'finance', include_deprecated: false,
    }, 's', 'm');
    expect((active.packs as Array<Record<string, unknown>>).map((pack) => pack.version))
      .toEqual(['1.1.0']);
  });

  it('get_and_validate_attach_provenance_and_gate_status', () => {
    const get = executeRolePackRead('builtin-role_pack_get',
      { packId: 'legal-review', version: '1.0.0' }, 'sess_1', 'msg_1');
    expect((get.pack as Record<string, unknown>).id).toBe('legal-review');
    const provenance = get.taskProvenance as Record<string, unknown>;
    expect(provenance.selectionKey).toBe('legal-review@1.0.0');
    expect(provenance.registryRevision).toBe(ROLE_PACK_REGISTRY_REVISION);
    expect(provenance.sessionId).toBe('sess_1');
    expect(provenance.messageId).toBe('msg_1');
    expect(provenance.inputDigest).toBeNull();
    expect((get.auditManifest as Record<string, unknown>).automatedFinalDecisionAllowed)
      .toBe(false);
    expect((get.auditManifest as Record<string, unknown>).humanFinalReviewRequired).toBe(true);

    const validated = executeRolePackRead('role_pack_validate', {
      pack_id: 'legal-review', version: '1.0.0', inputs: { contractSet: 'contracts/' },
    }, 's', 'm');
    expect(validated.valid).toBe(false);
    expect(validated.errors).toEqual(['missing required input: reviewPlaybook']);
    const gates = validated.gateStatus as Array<Record<string, unknown>>;
    expect(gates[0]).toEqual({ gate: 'input_schema_valid', status: 'failed' });
    expect(gates[1]).toEqual({ gate: 'source_evidence_complete', status: 'pending' });
    expect(validated.readyForHumanFinalReview).toBe(false);
    expect((validated.taskProvenance as Record<string, unknown>).inputDigest)
      .toMatch(/^[0-9a-f]{64}$/);
  });

  it('provenance_digest_changes_with_inputs', () => {
    const pack = findRolePack('legal-review', '1.0.0')!;
    const first = rolePackProvenance(pack, 's', 'm', { contractSet: 'a' });
    const second = rolePackProvenance(pack, 's', 'm', { contractSet: 'b' });
    expect((first.taskProvenance as Record<string, unknown>).inputDigest)
      .not.toBe((second.taskProvenance as Record<string, unknown>).inputDigest);
  });
});

describe('role_packs.rs versioned registry', () => {
  it('registry_covers_all_required_domains_and_contract_fields', () => {
    const registry = rolePackRegistry();
    for (const domain of ['finance', 'legal', 'hr', 'operations', 'admin', 'research',
      'teaching', 'content']) {
      expect(registry.some((pack) => pack.domain === domain), domain).toBe(true);
    }
    for (const pack of registry) {
      expect(pack.version, pack.id).not.toBe('');
      expect(pack.inputSchema.required, pack.id).toBeDefined();
      expect(pack.rules.length > 0 && pack.rubric.length > 0).toBe(true);
      expect(pack.templateRefs.length > 0 && pack.requiredCapabilities.length > 0).toBe(true);
      expect((pack.exceptionQueueSchema as Record<string, unknown>).items).toBeDefined();
      expect(pack.verificationGates).toContain('human_final_review');
      expect((pack.deliveryManifest as Record<string, unknown>).required).toBeDefined();
      if (pack.highRisk) expect(pack.humanFinalReviewRequired).toBe(true);
    }
  });

  it('explicit_old_version_remains_selectable_and_latest_is_newest', () => {
    expect(findRolePack('finance-core', '1.0.0')!.version).toBe('1.0.0');
    expect(findRolePack('finance-core', null)!.version).toBe('1.1.0');
    expect(findRolePack('finance-core', '2.0.0')).toBeNull();
    expect(findRolePack('missing-pack', null)).toBeNull();
  });

  it('registry_covers_required_composable_workflows_with_human_review', () => {
    for (const workflowId of ['invoice-reconcile', 'contract-review', 'resume-batch',
      'mail-merge', 'operations-report']) {
      const workflow = rolePackRegistry()
        .flatMap((pack) => pack.workflows)
        .find((entry) => entry.id === workflowId);
      expect(workflow, workflowId).toBeDefined();
      expect(workflow!.steps.length).toBeGreaterThanOrEqual(5);
      expect(workflow!.humanFinalReviewRequired).toBe(true);
    }
  });

  it('schema_validation_reports_missing_inputs', () => {
    const pack = findRolePack('legal-review', '1.0.0')!;
    expect(validateRolePackInput(pack, { contractSet: 'contracts/' }))
      .toEqual(['missing required input: reviewPlaybook']);
    expect(validateRolePackInput(pack, null)).toEqual(['inputs must be an object']);
  });
});
