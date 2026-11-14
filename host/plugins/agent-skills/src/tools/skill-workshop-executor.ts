/**
 * Agent skill workshop proposal/apply tools, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs`.
 *
 * `skill_workshop_propose` creates/updates/lists/rejects pending proposals in
 * `<appData>/skill_proposals`; `skill_workshop_apply` verifies the approved
 * content hash and proposal revision, checks the live skill for TOCTOU drift,
 * then publishes the full package atomically through `StagedSkillDirectory` and
 * records provenance. Applied skills are untrusted until `skill_trust_request`
 * grants trust.
 */
import fs from 'node:fs';
import path from 'node:path';
import { StagedSkillDirectory } from '../skill-package.ts';
import {
  AGENT_INSTALLED_MARKER, POST_WRITE_TRUST_NEXT_STEP,
} from './skill-install-executor.ts';
import { toRfc3339 } from '../../../../platform/time/index.ts';
import {
  SKILL_FILE_NAME, U64_MAX, asRecord, errorText, exactUnsigned, normalizeWorkshopSha256,
  packageFileMeta, packageFilesFromArgs, packageSha256, readPackageDirectory, sha256Hex,
  validatePackageFiles, workshopJson, workshopRisk, type ProposalFileMeta, type WorkshopUnsigned,
} from './skill-workshop-package.ts';
import {
  countPendingProposals, generateProposalId, parseAgentWorkshopMarkerVersion, proposalDir,
  proposalRevisionSha256, readProposalMeta, readProposalPackage, validateProposalId,
  validateWorkshopSkillId, verifyApprovedProposal, writeProposalFiles, writeProposalMeta,
  type AgentWorkshopMarker, type ProposalMeta, type WorkshopLogger,
} from './skill-workshop-proposals.ts';

export const SKILL_WORKSHOP_PROPOSE = 'skill_workshop_propose';
export const SKILL_WORKSHOP_APPLY = 'skill_workshop_apply';
export const APPLY_SUCCESS_MESSAGE =
  'Skill written to ~/.deep-student/skills. It is untrusted by default — call '
  + 'skill_trust_request with action=inspect then grant before the skill body injects or package '
  + 'scripts can run via SKILL_DIR. Do not load_skills until trust is granted. Skills management '
  + 'is only a backup.';
export const MAX_PENDING_PROPOSALS = 50;
export const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';
export const DEFAULT_AGENT_SKILLS_BASE_DISPLAY = '~/.deep-student/skills';

export interface SkillWorkshopProvenance {
  sourceKind: string;
  sourceDetail: string;
  packageSha256: string;
  riskLevel: string;
  installedAt: string;
  sessionId: string;
  packageVersion: WorkshopUnsigned;
  files: ProposalFileMeta[];
  previousPackageSha256?: string;
}

export interface WorkshopSettingsStore {
  getSetting(key: string): string | null;
  saveSetting(key: string, value: string): void;
  deleteSetting(key: string): string | void;
}

export interface SkillWorkshopOptions {
  /**
   * `<appData>/skill_proposals`. A resolver runs at Rust `proposals_root(ctx)`
   * (`skill_workshop_executor.rs:944,1079`), after argument validation.
   */
  proposalsRoot: string | (() => string);
  /** Expanded `~/.deep-student/skills`. */
  skillsBase: string;
  sessionId: string;
  /** Optional `validate_skill_path` replacement (throws on disallowed targets). */
  validateSkillPath?: (skillFile: string) => void;
  provenanceStore?: WorkshopSettingsStore | null;
  now?: () => Date;
  proposalSuffix?: () => string;
  logger?: WorkshopLogger;
}

function skillIdArg(args: Record<string, unknown>, action: string): string {
  const raw = args.skill_id ?? args.skillId;
  if (typeof raw !== 'string') throw new Error(`skill_id is required for ${action}`);
  validateWorkshopSkillId(raw);
  return raw;
}

/** `skill_workshop_propose`: create / update / list / reject. */
export class SkillWorkshopExecutor {
  private readonly options: SkillWorkshopOptions;

  constructor(options: SkillWorkshopOptions) {
    this.options = options;
  }

  static stripNamespace(toolName: string): string {
    if (toolName.startsWith('builtin-')) return toolName.slice(8);
    if (toolName.startsWith('mcp_')) return toolName.slice(4);
    return toolName;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private proposalsRoot(): string {
    const root = this.options.proposalsRoot;
    return typeof root === 'string' ? root : root();
  }

  private skillTargetPath(skillId: string): string {
    const target = path.join(this.options.skillsBase, skillId, SKILL_FILE_NAME);
    this.options.validateSkillPath?.(target);
    return target;
  }

  private relativeSkillDisplay(skillId: string): string {
    return `${DEFAULT_AGENT_SKILLS_BASE_DISPLAY}/${skillId}/${SKILL_FILE_NAME}`;
  }

  private newProposalMeta(
    proposalId: string,
    action: string,
    skillId: string,
    contentSha256: string,
    previousSha256?: string,
    packageSha256Value?: string,
    files: ProposalFileMeta[] = [],
    previousPackageSha256?: string,
    previousFiles: ProposalFileMeta[] = [],
    packageVersion: WorkshopUnsigned = 1,
  ): ProposalMeta {
    return {
      proposalId,
      action,
      skillId,
      contentSha256,
      createdAt: toRfc3339(BigInt(this.now().getTime()) * 1_000_000n),
      sessionId: this.options.sessionId,
      status: 'pending',
      ...(previousSha256 === undefined ? {} : { previousSha256 }),
      ...(packageSha256Value === undefined ? {} : { packageSha256: packageSha256Value }),
      files,
      ...(previousPackageSha256 === undefined ? {} : { previousPackageSha256 }),
      previousFiles,
      packageVersion,
    };
  }

  propose(args: unknown): Record<string, unknown> {
    const record = asRecord(args);
    const action = record.action;
    if (typeof action !== 'string') {
      throw new Error('action is required (propose_create | propose_update | list | reject)');
    }
    const root = this.proposalsRoot();
    switch (action) {
      case 'propose_create': return this.proposeCreate(record, root);
      case 'propose_update': return this.proposeUpdate(record, root);
      case 'list': return this.list(root);
      case 'reject': return this.reject(record, root);
      default:
        throw new Error(
          `Unsupported action '${action}'. Allowed: propose_create, propose_update, list, reject`,
        );
    }
  }

  private proposeCreate(args: Record<string, unknown>, root: string): Record<string, unknown> {
    const skillId = skillIdArg(args, 'propose_create');
    const [files, isFullPackage] = packageFilesFromArgs(args);
    const skill = files.find(file => file.path === SKILL_FILE_NAME)!;
    if (countPendingProposals(root) >= MAX_PENDING_PROPOSALS) {
      throw new Error(
        `Too many pending proposals (max ${MAX_PENDING_PROPOSALS}). `
        + 'Reject or apply existing proposals first.',
      );
    }
    const proposalId = generateProposalId(this.now(), this.options.proposalSuffix);
    const contentSha256 = sha256Hex(skill.bytes);
    const packageSha256Value = packageSha256(files);
    const manifest = packageFileMeta(files);
    const meta = this.newProposalMeta(
      proposalId, 'propose_create', skillId, contentSha256, undefined,
      packageSha256Value, manifest,
    );
    const [riskLevel, riskSignals] = workshopRisk(files);
    writeProposalFiles(proposalDir(root, proposalId), files, meta, this.options.logger);
    return {
      proposal_id: proposalId,
      action: 'propose_create',
      skill_id: skillId,
      content_sha256: contentSha256,
      proposal_revision: proposalRevisionSha256(meta),
      content_length: skill.bytes.length,
      package_sha256: packageSha256Value,
      package_version: 1,
      files: manifest,
      full_package: isFullPackage,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      status: 'pending',
      next_step: 'After user reviews the proposal, call skill_workshop_apply with proposal_id, '
        + 'skill_id, expected_content_sha256, and expected_proposal_revision from this result. '
        + 'Apply requires user approval and cannot be remembered.',
    };
  }

  private proposeUpdate(args: Record<string, unknown>, root: string): Record<string, unknown> {
    const skillId = skillIdArg(args, 'propose_update');
    let [files, isFullPackage] = packageFilesFromArgs(args);
    const target = this.skillTargetPath(skillId);
    if (!fs.existsSync(target)) {
      throw new Error(
        `Skill '${skillId}' does not exist at ${this.relativeSkillDisplay(skillId)}. `
        + 'Use propose_create for new skills.',
      );
    }
    let existingBytes: Buffer;
    try { existingBytes = fs.readFileSync(target); }
    catch (error) { throw new Error(`Failed to read existing SKILL.md: ${errorText(error)}`); }
    const previousSha256 = sha256Hex(existingBytes);
    const skillDir = path.dirname(target);
    const existingPackage = readPackageDirectory(skillDir);
    const previousPackageSha256 = packageSha256(existingPackage);
    const previousFiles = packageFileMeta(existingPackage);
    if (!isFullPackage) {
      const newSkill = files.pop()!;
      files = [...existingPackage];
      const slot = files.findIndex(file => file.path === SKILL_FILE_NAME);
      if (slot >= 0) files[slot] = newSkill; else files.push(newSkill);
      files = validatePackageFiles(files);
    }
    const skill = files.find(file => file.path === SKILL_FILE_NAME)!;
    let previousVersion: WorkshopUnsigned = 0;
    try {
      const markerText = fs.readFileSync(path.join(skillDir, AGENT_INSTALLED_MARKER), 'utf8');
      previousVersion = parseAgentWorkshopMarkerVersion(markerText);
    } catch { previousVersion = 0; }
    if (countPendingProposals(root) >= MAX_PENDING_PROPOSALS) {
      throw new Error(
        `Too many pending proposals (max ${MAX_PENDING_PROPOSALS}). `
        + 'Reject or apply existing proposals first.',
      );
    }
    const proposalId = generateProposalId(this.now(), this.options.proposalSuffix);
    const contentSha256 = sha256Hex(skill.bytes);
    const packageSha256Value = packageSha256(files);
    const manifest = packageFileMeta(files);
    // Rust u64::saturating_add(1).max(1); do not round before hashing/persisting.
    const previous = BigInt(previousVersion);
    const packageVersion = exactUnsigned(previous === U64_MAX ? U64_MAX : previous + 1n);
    const meta = this.newProposalMeta(
      proposalId, 'propose_update', skillId, contentSha256, previousSha256,
      packageSha256Value, manifest, previousPackageSha256, previousFiles, packageVersion,
    );
    const [riskLevel, riskSignals] = workshopRisk(files);
    writeProposalFiles(proposalDir(root, proposalId), files, meta, this.options.logger);
    return {
      proposal_id: proposalId,
      action: 'propose_update',
      skill_id: skillId,
      content_sha256: contentSha256,
      proposal_revision: proposalRevisionSha256(meta),
      previous_sha256: previousSha256,
      content_length: skill.bytes.length,
      package_sha256: packageSha256Value,
      // This is a Host value, not a serialized IPC payload. Keep D3 precision.
      package_version: packageVersion,
      previous_package_sha256: previousPackageSha256,
      files: manifest,
      full_package: isFullPackage,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      status: 'pending',
      next_step: 'After user reviews the diff, call skill_workshop_apply with proposal_id, '
        + 'skill_id, expected_content_sha256, and expected_proposal_revision from this result. '
        + 'Apply requires user approval and cannot be remembered.',
    };
  }

  private list(root: string): Record<string, unknown> {
    if (!fs.existsSync(root)) return { pending: [], count: 0 };
    const pending: Record<string, unknown>[] = [];
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      let meta: ProposalMeta;
      try { meta = readProposalMeta(dir); } catch { continue; }
      if (meta.status !== 'pending') continue;
      let contentLength = 0;
      try { contentLength = fs.statSync(path.join(dir, SKILL_FILE_NAME)).size; }
      catch { contentLength = 0; }
      pending.push({
        proposal_id: meta.proposalId,
        action: meta.action,
        skill_id: meta.skillId,
        content_sha256: meta.contentSha256,
        package_sha256: meta.packageSha256 ?? null,
        package_version: meta.packageVersion,
        previous_package_sha256: meta.previousPackageSha256 ?? null,
        files: meta.files,
        proposal_revision: proposalRevisionSha256(meta),
        created_at: meta.createdAt,
        content_length: contentLength,
      });
    }
    pending.sort((left, right) => {
      const leftCreated = String(left.created_at ?? '');
      const rightCreated = String(right.created_at ?? '');
      return Buffer.compare(Buffer.from(rightCreated), Buffer.from(leftCreated));
    });
    return { pending, count: pending.length };
  }

  private reject(args: Record<string, unknown>, root: string): Record<string, unknown> {
    const raw = args.proposal_id ?? args.proposalId;
    if (typeof raw !== 'string') throw new Error('proposal_id is required for reject');
    validateProposalId(raw);
    const dir = proposalDir(root, raw);
    if (!fs.existsSync(dir)) throw new Error(`Proposal '${raw}' not found`);
    const meta = readProposalMeta(dir);
    if (meta.status !== 'pending') {
      throw new Error(
        `Proposal '${raw}' status is '${meta.status}' (only pending proposals can be rejected)`,
      );
    }
    const rejected = { ...meta, status: 'rejected' };
    writeProposalMeta(dir, rejected, this.options.logger);
    return {
      proposal_id: raw,
      status: 'rejected',
      skill_id: meta.skillId,
      message: 'Proposal rejected; files retained for audit.',
    };
  }

  private provenancePayloads(
    proposalId: string,
    contentSha256: string,
    packageSha256Value: string,
    packageVersion: WorkshopUnsigned,
    files: readonly ProposalFileMeta[],
    previousPackageSha256: string | undefined,
    riskLevel: string,
    installedAt: string,
    sessionId: string,
  ): [string, string] {
    const marker: AgentWorkshopMarker = {
      sourceKind: 'agent_workshop',
      proposalId,
      contentSha256,
      packageSha256: packageSha256Value,
      packageVersion,
      files: [...files],
      ...(previousPackageSha256 === undefined ? {} : { previousPackageSha256 }),
      installedAt,
      sessionId,
    };
    const provenance: SkillWorkshopProvenance = {
      sourceKind: 'agent_workshop',
      sourceDetail: proposalId,
      packageSha256: packageSha256Value,
      riskLevel,
      installedAt,
      sessionId,
      packageVersion,
      files: [...files],
      ...(previousPackageSha256 === undefined ? {} : { previousPackageSha256 }),
    };
    return [workshopJson(marker, 2), workshopJson(provenance, 2)];
  }

  private persistProvenance(skillId: string, provenanceText: string): string | null | undefined {
    const store = this.options.provenanceStore;
    if (store === null || store === undefined) {
      this.options.logger?.warn?.(
        `[SkillWorkshopExecutor] main_db unavailable; provenance for '${skillId}' written only `
        + 'to marker file',
      );
      return undefined;
    }
    const key = `${PROVENANCE_SETTINGS_PREFIX}${skillId}`;
    let previous: string | null;
    try { previous = store.getSetting(key); }
    catch (error) {
      throw new Error(`Failed to read previous skill provenance: ${errorText(error)}`);
    }
    try { store.saveSetting(key, provenanceText); }
    catch (error) { throw new Error(`Failed to persist skill provenance: ${errorText(error)}`); }
    return previous;
  }

  private restoreProvenance(
    skillId: string,
    previous: string | null | undefined,
  ): void {
    if (previous === undefined) return;
    const store = this.options.provenanceStore;
    if (store === null || store === undefined) {
      throw new Error('main_db disappeared while restoring provenance');
    }
    const key = `${PROVENANCE_SETTINGS_PREFIX}${skillId}`;
    try {
      if (previous !== null) store.saveSetting(key, previous);
      else store.deleteSetting(key);
    } catch (error) {
      throw new Error(`Failed to restore previous skill provenance: ${errorText(error)}`);
    }
  }

  apply(args: unknown): Record<string, unknown> {
    const record = asRecord(args);
    const rawProposalId = record.proposal_id ?? record.proposalId;
    if (typeof rawProposalId !== 'string') throw new Error('proposal_id is required');
    validateProposalId(rawProposalId);
    const rawContentHash = record.expected_content_sha256 ?? record.expectedContentSha256;
    if (typeof rawContentHash !== 'string') {
      throw new Error('expected_content_sha256 is required from the reviewed proposal result');
    }
    const expectedContentSha256 = normalizeWorkshopSha256(rawContentHash, 'expected_content_sha256');
    const rawRevision = record.expected_proposal_revision ?? record.expectedProposalRevision;
    if (typeof rawRevision !== 'string') {
      throw new Error('expected_proposal_revision is required from the reviewed proposal result');
    }
    const expectedRevision = normalizeWorkshopSha256(rawRevision, 'expected_proposal_revision');
    const rawSkillId = record.skill_id ?? record.skillId;
    if (typeof rawSkillId !== 'string') {
      throw new Error('skill_id is required from the reviewed proposal result');
    }
    validateWorkshopSkillId(rawSkillId);
    const overwrite = record.overwrite === true;

    const dir = proposalDir(this.proposalsRoot(), rawProposalId);
    if (!fs.existsSync(dir)) throw new Error(`Proposal '${rawProposalId}' not found`);
    const meta = readProposalMeta(dir);
    if (meta.status !== 'pending') {
      throw new Error(
        `Proposal '${rawProposalId}' status is '${meta.status}' `
        + '(only pending proposals can be applied)',
      );
    }
    if (meta.skillId !== rawSkillId) {
      throw new Error(
        `Proposal target changed after approval scope was created: expected skill_id `
        + `'${rawSkillId}', got '${meta.skillId}'. Review the proposal again before applying.`,
      );
    }
    const proposalFiles = readProposalPackage(dir, meta);
    const actualSha256 = verifyApprovedProposal(
      meta, proposalFiles, expectedContentSha256, expectedRevision,
    );
    const packageSha256Value = packageSha256(proposalFiles);
    const manifest = packageFileMeta(proposalFiles);
    const [riskLevel, riskSignals] = workshopRisk(proposalFiles);
    const target = this.skillTargetPath(meta.skillId);
    const skillDir = path.dirname(target);

    if (meta.action === 'propose_update') {
      if (meta.previousSha256 === undefined) {
        throw new Error('propose_update proposal missing previous_sha256 in meta');
      }
      if (!fs.existsSync(target)) {
        throw new Error(`Target skill '${meta.skillId}' no longer exists. Create a new proposal.`);
      }
      let currentBytes: Buffer;
      try { currentBytes = fs.readFileSync(target); }
      catch (error) { throw new Error(`Failed to read target SKILL.md: ${errorText(error)}`); }
      const currentSha256 = sha256Hex(currentBytes);
      if (currentSha256 !== meta.previousSha256) {
        throw new Error(
          `Target SKILL.md changed since proposal (TOCTOU): expected previous_sha256 `
          + `${meta.previousSha256}, got ${currentSha256}. The live skill was modified — call `
          + 'propose_update again with the current content.',
        );
      }
      const currentPackage = readPackageDirectory(skillDir);
      const currentPackageSha256 = packageSha256(currentPackage);
      const expectedPreviousPackage = meta.previousPackageSha256 ?? meta.previousSha256;
      if (currentPackageSha256 !== expectedPreviousPackage) {
        throw new Error(
          `Target skill package changed since proposal (TOCTOU): expected `
          + `${expectedPreviousPackage}, got ${currentPackageSha256}. Create a new proposal from `
          + 'the current package.',
        );
      }
    } else if (meta.action === 'propose_create') {
      if (fs.existsSync(skillDir) && !overwrite) {
        throw new Error(
          `Skill directory already exists at ${this.relativeSkillDisplay(meta.skillId)}. `
          + 'Pass overwrite=true to replace, or choose a different skill_id.',
        );
      }
    } else {
      throw new Error(`Unsupported proposal action '${meta.action}'`);
    }

    const commitOverwrite = meta.action === 'propose_update' || overwrite;
    const installedAt = toRfc3339(BigInt(this.now().getTime()) * 1_000_000n);
    const [markerText, provenanceText] = this.provenancePayloads(
      rawProposalId, actualSha256, packageSha256Value, meta.packageVersion, manifest,
      meta.previousPackageSha256, riskLevel, installedAt, this.options.sessionId,
    );
    const preserveExisting = fs.existsSync(skillDir) && meta.files.length === 0;
    const staged = StagedSkillDirectory.create(
      skillDir, commitOverwrite, preserveExisting, this.options.logger,
    );
    try {
      for (const file of proposalFiles) staged.writeFile(file.path, file.bytes);
      staged.writeFile(AGENT_INSTALLED_MARKER, Buffer.from(markerText, 'utf8'));
    } catch (error) {
      staged.dispose();
      throw error;
    }

    const committed = meta.action === 'propose_update' && meta.previousFiles.length > 0
      ? staged.commitIfManifestUnchanged(
        meta.previousFiles.map(file => [file.path, file.sha256] as const),
        [AGENT_INSTALLED_MARKER],
      )
      : meta.action === 'propose_update'
        ? staged.commitIfFileUnchanged(SKILL_FILE_NAME, meta.previousSha256!)
        : staged.commit();

    let previousProvenance: string | null | undefined;
    try {
      previousProvenance = this.persistProvenance(meta.skillId, provenanceText);
    } catch (provenanceError) {
      try {
        committed.rollback();
        throw new Error(
          `Failed to persist agent provenance (${errorText(provenanceError)}); `
          + 'the previous skill was restored.',
        );
      } catch (rollbackError) {
        if (rollbackError instanceof Error
          && rollbackError.message.includes('the previous skill was restored')) {
          throw rollbackError;
        }
        throw new Error(
          `Failed to persist agent provenance (${errorText(provenanceError)}), and failed to `
          + `restore the previous skill (${errorText(rollbackError)}).`,
        );
      }
    }

    const appliedMeta: ProposalMeta = { ...meta, status: 'applied' };
    try { writeProposalMeta(dir, appliedMeta, this.options.logger); }
    catch (metaError) {
      const restoreError = (() => {
        try { this.restoreProvenance(meta.skillId, previousProvenance); return undefined; }
        catch (error) { return error; }
      })();
      const rollbackError = (() => {
        try { committed.rollback(); return undefined; }
        catch (error) { return error; }
      })();
      if (restoreError === undefined && rollbackError === undefined) {
        throw new Error(
          `Failed to mark proposal as applied (${errorText(metaError)}); provenance and the `
          + 'live skill were restored.',
        );
      }
      throw new Error(
        `Failed to mark proposal as applied (${errorText(metaError)}); rollback was incomplete `
        + `(provenance=${restoreError === undefined ? 'ok' : errorText(restoreError)}, `
        + `skill=${rollbackError === undefined ? 'ok' : errorText(rollbackError)}).`,
      );
    }
    committed.finalize();

    return {
      applied: true,
      proposal_id: rawProposalId,
      action: appliedMeta.action,
      skill_id: appliedMeta.skillId,
      path: this.relativeSkillDisplay(appliedMeta.skillId),
      content_sha256: actualSha256,
      package_sha256: packageSha256Value,
      package_version: appliedMeta.packageVersion,
      previous_package_sha256: appliedMeta.previousPackageSha256 ?? null,
      files: manifest,
      risk_level: riskLevel,
      risk_signals: riskSignals,
      trust_status: 'untrusted',
      message: APPLY_SUCCESS_MESSAGE,
      next_step: POST_WRITE_TRUST_NEXT_STEP,
    };
  }

  canHandle(toolName: string): boolean { return canHandleSkillWorkshopTool(toolName); }

  sensitivityLevel(toolName: string): 'medium' | 'high' { return skillWorkshopSensitivity(toolName); }

  name(): string { return SKILL_WORKSHOP_EXECUTOR_NAME; }
}

/** Rust `ToolExecutor::name` (`skill_workshop_executor.rs:1340-1342`). */
export const SKILL_WORKSHOP_EXECUTOR_NAME = 'SkillWorkshopExecutor';

/** Rust `can_handle` (`skill_workshop_executor.rs:1325-1330`). */
export function canHandleSkillWorkshopTool(toolName: string): boolean {
  const stripped = SkillWorkshopExecutor.stripNamespace(toolName);
  return stripped === SKILL_WORKSHOP_PROPOSE || stripped === SKILL_WORKSHOP_APPLY;
}

/** Rust `sensitivity_level` (`skill_workshop_executor.rs:1332-1338`). */
export function skillWorkshopSensitivity(toolName: string): 'medium' | 'high' {
  return SkillWorkshopExecutor.stripNamespace(toolName) === SKILL_WORKSHOP_APPLY ? 'high' : 'medium';
}
