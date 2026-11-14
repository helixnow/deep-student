/**
 * Versioned role pack registry (role_packs.rs:1–356) and the read-only
 * executor helpers (role_pack_executor.rs:22–168).
 */
import { stripToolNamespace } from './automation-tool-args.ts';
import { createHasherSync } from '../../../platform/crypto/sync.ts';

export const ROLE_PACK_REGISTRY_REVISION = '2026-07-19.1';
export const ROLE_PACK_EXECUTOR_NAME = 'RolePackExecutor';

export const ROLE_PACK_TOOL_NAMES = {
  list: 'role_pack_list',
  get: 'role_pack_get',
  validate: 'role_pack_validate',
} as const;

export interface RolePackWorkflow {
  id: string;
  title: string;
  steps: string[];
  humanFinalReviewRequired: boolean;
}

export interface RolePack {
  id: string;
  domain: string;
  title: string;
  version: string;
  deprecated: boolean;
  inputSchema: Record<string, unknown>;
  rules: string[];
  rubric: string[];
  templateRefs: string[];
  requiredCapabilities: string[];
  exceptionQueueSchema: Record<string, unknown>;
  verificationGates: string[];
  deliveryManifest: Record<string, unknown>;
  workflows: RolePackWorkflow[];
  highRisk: boolean;
  humanFinalReviewRequired: boolean;
}

function workflow(id: string, title: string, steps: readonly string[]): RolePackWorkflow {
  return { id, title, steps: [...steps], humanFinalReviewRequired: true };
}

const RULES: readonly string[] = [
  'Preserve source evidence and never invent missing fields',
  'Route ambiguity, policy conflicts, and unsupported conclusions to the exception queue',
  'Do not execute irreversible delivery actions from a role pack',
];

const RUBRIC: readonly string[] = [
  'Every conclusion is traceable to an input or rule',
  'Exceptions include owner, severity, evidence, and recommended next action',
  'Delivery manifest counts reconcile with processed and exception items',
];

const VERIFICATION_GATES: readonly string[] = [
  'input_schema_valid',
  'source_evidence_complete',
  'exception_queue_reconciled',
  'delivery_manifest_reconciled',
  'human_final_review',
];

function pack(
  id: string,
  domain: string,
  title: string,
  version: string,
  deprecated: boolean,
  requiredInputs: readonly string[],
  capabilities: readonly string[],
  workflows: RolePackWorkflow[],
  highRisk: boolean,
): RolePack {
  const properties: Record<string, unknown> = {};
  for (const name of requiredInputs) {
    properties[name] = { type: 'string', minLength: 1 };
  }
  return {
    id,
    domain,
    title,
    version,
    deprecated,
    inputSchema: {
      type: 'object',
      additionalProperties: true,
      required: [...requiredInputs],
      properties,
    },
    rules: [...RULES],
    rubric: [...RUBRIC],
    templateRefs: [
      `builtin://role-packs/${id}/${version}/report`,
      `builtin://role-packs/${id}/${version}/exceptions`,
    ],
    requiredCapabilities: [...capabilities],
    exceptionQueueSchema: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['itemId', 'severity', 'reason', 'evidenceRefs', 'owner', 'status'],
        properties: {
          itemId: { type: 'string' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          reason: { type: 'string' },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
          owner: { type: 'string' },
          status: { type: 'string', enum: ['open', 'reviewed', 'resolved', 'waived'] },
        },
      },
    },
    verificationGates: [...VERIFICATION_GATES],
    deliveryManifest: {
      schemaVersion: 1,
      required: ['rolePackId', 'rolePackVersion', 'inputDigest', 'outputArtifacts',
        'processedCount', 'exceptionCount', 'verificationGates', 'reviewDecision'],
      reviewDecision: {
        enum: ['pending', 'approved', 'rejected', 'approved_with_exceptions'],
      },
    },
    workflows,
    highRisk,
    humanFinalReviewRequired: true,
  };
}

function buildRegistry(): RolePack[] {
  return [
    pack(
      'finance-core', 'finance', 'Finance Reconciliation', '1.0.0', true,
      ['invoiceBatch', 'ledgerSnapshot'],
      ['xlsx', 'workspace_read'],
      [workflow('invoice-reconcile', 'Invoice reconcile', [
        'ingest invoices and ledger',
        'normalize vendor and amount fields',
        'match and classify variances',
        'queue unresolved exceptions',
        'produce reconciliation workbook and manifest',
        'human finance owner final review',
      ])],
      true,
    ),
    pack(
      'finance-core', 'finance', 'Finance Reconciliation', '1.1.0', false,
      ['invoiceBatch', 'ledgerSnapshot', 'materialityPolicy'],
      ['xlsx', 'workspace_read'],
      [workflow('invoice-reconcile', 'Invoice reconcile', [
        'ingest invoices and ledger',
        'normalize vendor, tax, currency, and amount fields',
        'match under materiality policy',
        'queue unresolved exceptions',
        'produce reconciliation workbook and manifest',
        'human finance owner final review',
      ])],
      true,
    ),
    pack(
      'legal-review', 'legal', 'Legal Review', '1.0.0', false,
      ['contractSet', 'reviewPlaybook'],
      ['docx', 'workspace_read'],
      [workflow('contract-review', 'Contract review', [
        'ingest contract and playbook',
        'extract clauses with citations',
        'compare deviations against playbook',
        'queue ambiguous or high-risk clauses',
        'produce redline issue list',
        'licensed counsel final review',
      ])],
      true,
    ),
    pack(
      'hr-operations', 'hr', 'HR Operations', '1.0.0', false,
      ['resumeBatch', 'jobCriteria'],
      ['document_parse', 'workspace_read'],
      [workflow('resume-batch', 'Resume batch', [
        'ingest resumes and job criteria',
        'extract job-relevant evidence only',
        'apply consistent rubric',
        'queue missing or ambiguous evidence',
        'produce review matrix without protected-trait inference',
        'authorized HR reviewer final decision',
      ])],
      true,
    ),
    pack(
      'operations-control', 'operations', 'Operations Control', '1.0.0', false,
      ['operatingData', 'reportingPeriod'],
      ['xlsx', 'docx', 'workspace_read'],
      [workflow('operations-report', 'Operations report', [
        'ingest period data',
        'validate completeness and reconcile totals',
        'calculate approved metrics',
        'queue anomalies and missing owners',
        'produce operations report and manifest',
        'operations owner final review',
      ])],
      false,
    ),
    pack(
      'admin-communications', 'admin', 'Administrative Communications', '1.0.0', false,
      ['recipientTable', 'approvedTemplate'],
      ['docx', 'xlsx', 'workspace_read'],
      [workflow('mail-merge', 'Mail merge', [
        'ingest approved template and recipients',
        'validate required merge fields',
        'render drafts only',
        'queue missing or invalid recipient data',
        'produce preview bundle and manifest',
        'authorized sender final review and send',
      ])],
      true,
    ),
    pack(
      'research-evidence', 'research', 'Research Evidence', '1.0.0', false,
      ['researchQuestion', 'sourceSet'],
      ['academic_search', 'workspace_read'],
      [],
      false,
    ),
    pack(
      'teaching-design', 'teaching', 'Teaching Design', '1.0.0', false,
      ['learningObjectives', 'learnerProfile'],
      ['qbank', 'docx'],
      [],
      false,
    ),
    pack(
      'content-production', 'content', 'Content Production', '1.0.0', false,
      ['contentBrief', 'sourceSet'],
      ['docx', 'workspace_read'],
      [],
      false,
    ),
  ];
}

let registryCache: RolePack[] | null = null;

export function rolePackRegistry(): readonly RolePack[] {
  registryCache ??= buildRegistry();
  return registryCache;
}

function versionParts(version: string): number[] {
  return version.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  });
}

function compareVersions(left: string, right: string): number {
  const a = versionParts(left);
  const b = versionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** role_packs.rs:340–356: exact versions stay selectable; omitted picks newest non-deprecated. */
export function findRolePack(packId: string, version?: string | null): RolePack | null {
  const matches = rolePackRegistry().filter((pack) => pack.id === packId);
  const trimmed = version === undefined || version === null ? '' : version.trim();
  if (trimmed !== '') {
    return matches.find((pack) => pack.version === trimmed) ?? null;
  }
  const active = matches.filter((pack) => !pack.deprecated);
  if (active.length > 0) {
    return active.reduce((best, pack) => compareVersions(pack.version, best.version) > 0 ? pack : best);
  }
  if (matches.length === 0) return null;
  return matches.reduce((best, pack) => compareVersions(pack.version, best.version) > 0 ? pack : best);
}

/** role_packs.rs:358–376. */
export function validateRolePackInput(pack: RolePack, input: unknown): string[] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return ['inputs must be an object'];
  }
  const object = input as Record<string, unknown>;
  const required = pack.inputSchema.required;
  if (!Array.isArray(required)) return [];
  const errors: string[] = [];
  for (const field of required) {
    if (typeof field !== 'string') continue;
    const value = object[field];
    const missing = value === undefined || value === null
      || (typeof value === 'string' && value.trim() === '');
    if (missing) errors.push(`missing required input: ${field}`);
  }
  return errors;
}

function stringAlias(object: Record<string, unknown>, snake: string, camel: string): string | null {
  const raw = object[snake] ?? object[camel];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** role_pack_executor.rs:33–55. */
export function selectedRolePack(args: unknown): RolePack {
  const object = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const packId = stringAlias(object, 'pack_id', 'packId');
  if (packId === null) throw new Error('pack_id is required');
  const version = stringAlias(object, 'version', 'version');
  const pack = findRolePack(packId, version);
  if (pack === null) {
    throw new Error(version === null
      ? `Role pack '${packId}' was not found`
      : `Role pack '${packId}' version '${version}' was not found`);
  }
  return pack;
}

function sha256Hex(value: unknown): string {
  return createHasherSync('SHA-256').update(JSON.stringify(value) ?? '').digestHex();
}

/** role_pack_executor.rs:57–79. */
export function rolePackProvenance(
  pack: RolePack, sessionId: string, messageId: string, input?: unknown,
): Record<string, unknown> {
  return {
    taskProvenance: {
      rolePackId: pack.id,
      rolePackVersion: pack.version,
      selectionKey: `${pack.id}@${pack.version}`,
      registryRevision: ROLE_PACK_REGISTRY_REVISION,
      sessionId,
      messageId,
      inputDigest: input === undefined ? null : sha256Hex(input),
    },
    auditManifest: {
      schemaVersion: 1,
      selectedRolePack: { id: pack.id, version: pack.version },
      registryRevision: ROLE_PACK_REGISTRY_REVISION,
      highRisk: pack.highRisk,
      humanFinalReviewRequired: pack.humanFinalReviewRequired,
      automatedFinalDecisionAllowed: false,
      verificationGates: pack.verificationGates,
      deliveryManifest: pack.deliveryManifest,
    },
  };
}

/** role_pack_executor.rs:81–159. */
export function executeRolePackRead(
  name: string, args: unknown, sessionId: string, messageId: string,
): Record<string, unknown> {
  const object = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? args as Record<string, unknown> : {};
  const bare = stripToolNamespace(name);
  if (bare === ROLE_PACK_TOOL_NAMES.list) {
    const domainRaw = object.domain;
    const domain = typeof domainRaw === 'string' ? domainRaw.trim() : null;
    const includeDeprecatedRaw = object.include_deprecated ?? object.includeDeprecated;
    const includeDeprecated = typeof includeDeprecatedRaw === 'boolean' ? includeDeprecatedRaw : true;
    const packs = rolePackRegistry()
      .filter((pack) => domain === null || domain === '' || pack.domain === domain)
      .filter((pack) => includeDeprecated || !pack.deprecated)
      .map((pack) => ({
        id: pack.id,
        domain: pack.domain,
        title: pack.title,
        version: pack.version,
        deprecated: pack.deprecated,
        highRisk: pack.highRisk,
        humanFinalReviewRequired: pack.humanFinalReviewRequired,
        workflowIds: pack.workflows.map((entry) => entry.id),
      }));
    return {
      registryRevision: ROLE_PACK_REGISTRY_REVISION,
      versionSelection: 'exact versions remain selectable; omit version only to select latest',
      packs,
    };
  }
  if (bare === ROLE_PACK_TOOL_NAMES.get) {
    const pack = selectedRolePack(object);
    return { pack, ...rolePackProvenance(pack, sessionId, messageId) };
  }
  if (bare === ROLE_PACK_TOOL_NAMES.validate) {
    const pack = selectedRolePack(object);
    const inputs = object.inputs ?? {};
    const errors = validateRolePackInput(pack, inputs);
    const schemaValid = errors.length === 0;
    return {
      valid: schemaValid,
      errors,
      selected: { id: pack.id, version: pack.version },
      gateStatus: pack.verificationGates.map((gate) => ({
        gate,
        status: gate === 'input_schema_valid' ? (schemaValid ? 'passed' : 'failed') : 'pending',
      })),
      readyForHumanFinalReview: false,
      humanFinalReviewRequired: true,
      ...rolePackProvenance(pack, sessionId, messageId, inputs),
    };
  }
  throw new Error(`Unsupported role pack tool: ${bare}`);
}

/** role_pack_executor.rs:164–166. */
export function canHandleRolePackTool(toolName: string): boolean {
  const bare = stripToolNamespace(toolName);
  return (Object.values(ROLE_PACK_TOOL_NAMES) as readonly string[]).includes(bare);
}

export function rolePackSensitivityLevel(): 'Low' {
  return 'Low';
}

export function rolePackConcurrencyClass(): 'ReadOnly' {
  return 'ReadOnly';
}
