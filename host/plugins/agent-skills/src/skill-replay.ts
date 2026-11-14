/**
 * G09-P1/P2 skill experience replay, promotion and rollback, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs`.
 *
 * No automatic behaviour: replay, promote and rollback are only reached from their
 * explicit commands. Replay re-runs the P0 probes as a dry-run drift check; promote renders
 * the statistical draft payload into a real SKILL.md through the same `StagedSkillDirectory`
 * pipeline as workshop apply; rollback retires the skill directory into `.archive/` instead of
 * deleting it.
 *
 * The portable half (payload parsing, drift probes, replay state machine, rendering, summaries)
 * lives in `skill-replay-core.ts` and is re-exported here; this module keeps the desktop
 * filesystem writes (`node:fs`), which the mobile host implements through `ctx.files`.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SkillCandidatePromotion, SkillCandidateRollback } from '../api.ts';
import { CandidateStatus, SkillCandidateRepo } from '../repository/skill-usage.ts';
import type { SkillCandidateRow } from '../repository/skill-usage.ts';
import { debugPath, ioMessage, type SkillFiles } from './files.ts';
import {
  DEFAULT_AGENT_SKILLS_BASE, StagedSkillDirectory, isPortableSkillPathComponent,
  type SkillPackageLogger,
} from './skill-package.ts';
import { AGENT_INSTALLED_MARKER } from './skill-taps.ts';
import { now } from '../../../platform/time/index.ts';
import {
  archiveStamp, buildLearnedSkillDraft, deriveLearnedSkillId, G09_FRONTMATTER_SOURCE,
  learnedSkillMarker, parseInstalledLineage, SKILL_ARCHIVE_SUBDIR, SKILL_FILE_NAME,
  type InstalledLineage,
} from './skill-replay-core.ts';

export {
  archiveStamp, buildLearnedSkillDraft, DEFAULT_LIST_LIMIT, deriveLearnedSkillId,
  DRIFT_ANCHOR_RUN_MISSING, DRIFT_ANCHOR_USER_MESSAGE_MISSING, DRIFT_ANCHOR_USAGE_MISSING,
  DRIFT_CORRECTION_MARK_MISSING, DRIFT_EVIDENCE_UNPARSEABLE, DRIFT_FAILURE_MARK_MISSING,
  DRIFT_OUTCOME_INVALIDATED, DRIFT_PAYLOAD_UNPARSEABLE, DRIFT_SKILLS_DIVERGED,
  DRIFT_TRACE_HASH_MISMATCH, DRIFT_USAGE_ROWS_MISSING, G09_FRONTMATTER_SOURCE,
  LEARNED_CORRECTION_PREFIX, LEARNED_WORKFLOW_PREFIX, learnedSkillMarker, learnedSkillSignature,
  listCandidateSummaries, MAX_LIST_LIMIT, normalizeCandidateId, normalizeListLimit,
  normalizeListStatus, parseCorrectionInput, parseInstalledLineage, parseStatusFilter,
  parseTrajectoryInput, recomputeTraceHash, reconcileProbes, replayCandidate, replayTransitions,
  sanitizeInline, SKILL_ARCHIVE_SUBDIR, SKILL_FILE_NAME, summaryFromRow,
} from './skill-replay-core.ts';
export type {
  CorrectionReconcileInput, InstalledLineage, LearnedSkillDraft, TrajectoryReconcileInput,
} from './skill-replay-core.ts';

// ------------------------------------------------------------------ installed lineage

function isFile(target: string): boolean {
  try { return statSync(target).isFile(); }
  catch { return false; }
}

/** 读取已安装技能的 frontmatter 血缘；文件不存在 undefined，无 frontmatter 全空。 */
export function readInstalledLineage(skillFile: string): InstalledLineage | undefined {
  if (!isFile(skillFile)) return undefined;
  let content: string;
  try {
    const bytes = readFileSync(skillFile);
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(`failed to read installed skill ${debugPath(skillFile)}: ${ioMessage(error)}`);
  }
  return parseInstalledLineage(content);
}

interface InstalledLearnedSkill {
  skillId: string;
  skillFilePath: string;
  version: number;
  /** false = 同 trace_hash 幂等命中既有文件（未改写）。 */
  written: boolean;
}

function installLearnedSkill(
  skillsBase: string,
  row: SkillCandidateRow,
  logger?: SkillPackageLogger,
): InstalledLearnedSkill {
  let version = 1;
  let draft = buildLearnedSkillDraft(row, version);
  const skillDir = path.join(skillsBase, draft.skillId);
  const skillFile = path.join(skillDir, SKILL_FILE_NAME);

  const lineage = readInstalledLineage(skillFile);
  if (lineage !== undefined) {
    if (lineage.source !== G09_FRONTMATTER_SOURCE) {
      throw new Error(
        `skill id collision: ${debugPath(skillFile)} exists but is not a G09-learned skill; refusing to overwrite`,
      );
    }
    if (lineage.traceHash === row.traceHash) {
      return {
        skillId: draft.skillId,
        skillFilePath: skillFile,
        version: lineage.version ?? 1,
        written: false,
      };
    }
    version = Math.max(1, (lineage.version ?? 0) + 1);
    draft = buildLearnedSkillDraft(row, version);
  }

  const { marker } = learnedSkillMarker(row, draft, version);

  const staged = StagedSkillDirectory.create(skillDir, true, false, logger);
  try {
    staged.writeFile(SKILL_FILE_NAME, Buffer.from(draft.markdown));
    staged.writeFile(AGENT_INSTALLED_MARKER, Buffer.from(JSON.stringify(marker, null, 2)));
    const committed = staged.commit();
    committed.finalize();
  } finally {
    staged.dispose();
  }

  return {
    skillId: draft.skillId,
    skillFilePath: skillFile,
    version,
    written: true,
  };
}

// ------------------------------------------------------------------ promote

/** Promote a validated (`passed`) candidate to `published` and write SKILL.md. */
export function promoteCandidateWithBase(
  db: SqlExecutor,
  candidateId: string,
  skillsBase: string,
  logger?: SkillPackageLogger,
): SkillCandidatePromotion {
  const repo = new SkillCandidateRepo(db);
  const row = repo.get(candidateId);
  if (row === undefined) throw new Error(`skill candidate not found: ${candidateId}`);
  let draftPayload: unknown;
  try { draftPayload = JSON.parse(row.draftPayloadJson); }
  catch (error) {
    throw new Error(
      `skill candidate ${candidateId} draft payload is unparseable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // 幂等通路：已发布候选重复 promote。
  if (row.status === 'published') {
    const skillId = deriveLearnedSkillId(row);
    const skillFile = path.join(skillsBase, skillId, SKILL_FILE_NAME);
    const lineage = readInstalledLineage(skillFile);
    if (lineage !== undefined) {
      if (lineage.traceHash === row.traceHash) {
        return {
          candidateId,
          status: 'published',
          draftPayload,
          promotedAt: now().rfc3339,
          skillId,
          skillFilePath: skillFile,
          skillVersion: lineage.version ?? 1,
          skillFileWritten: false,
        };
      }
      throw new Error(
        `skill candidate ${candidateId} is published but installed skill ${debugPath(skillFile)} lineage diverged (manual edit?); refusing to clobber`,
      );
    }
    const installed = installLearnedSkill(skillsBase, row, logger);
    return {
      candidateId,
      status: 'published',
      draftPayload,
      promotedAt: now().rfc3339,
      skillId: installed.skillId,
      skillFilePath: installed.skillFilePath,
      skillVersion: installed.version,
      skillFileWritten: installed.written,
    };
  }

  if (row.status !== 'passed') {
    throw new Error(
      `skill candidate ${candidateId} must be validated ('passed') before promote; current status '${row.status}'`,
    );
  }

  const installed = installLearnedSkill(skillsBase, row, logger);
  if (!repo.updateStatus(candidateId, 'passed', 'published')) {
    throw new Error(`skill candidate ${candidateId} status changed concurrently during promote`);
  }
  return {
    candidateId,
    status: 'published',
    draftPayload,
    promotedAt: now().rfc3339,
    skillId: installed.skillId,
    skillFilePath: installed.skillFilePath,
    skillVersion: installed.version,
    skillFileWritten: installed.written,
  };
}

// ------------------------------------------------------------------ rollback

/** 退役习得技能目录：重命名进 `<skills_base>/.archive/`（不物理删除）。 */
export function retireLearnedSkill(
  skillsBase: string,
  skillId: string,
): [string, string] | undefined {
  const skillDir = path.join(skillsBase, skillId);
  if (!existsSync(skillDir)) return undefined;
  const lineage = readInstalledLineage(path.join(skillDir, SKILL_FILE_NAME));
  if (lineage === undefined || lineage.source !== G09_FRONTMATTER_SOURCE) {
    throw new Error(
      `refusing to retire non-G09 skill directory ${debugPath(skillDir)} (lineage missing or diverged)`,
    );
  }
  const archiveRoot = path.join(skillsBase, SKILL_ARCHIVE_SUBDIR);
  try { mkdirSync(archiveRoot, { recursive: true }); }
  catch (error) {
    throw new Error(`failed to create skill archive dir ${debugPath(archiveRoot)}: ${ioMessage(error)}`);
  }
  const archived = path.join(archiveRoot, `${skillId}.rolledback-${archiveStamp()}`);
  try { renameSync(skillDir, archived); }
  catch (error) {
    throw new Error(
      `failed to retire skill directory ${debugPath(skillDir)} -> ${debugPath(archived)}: ${ioMessage(error)}`,
    );
  }
  return [skillDir, archived];
}

/** Move a `published` candidate to `rolled_back` and archive its skill directory. */
export function rollbackCandidateWithBase(
  db: SqlExecutor,
  candidateId: string,
  skillsBase: string,
): SkillCandidateRollback {
  const repo = new SkillCandidateRepo(db);
  const row = repo.get(candidateId);
  if (row === undefined) throw new Error(`skill candidate not found: ${candidateId}`);
  if (row.status !== 'published') {
    throw new Error(
      `skill candidate ${candidateId} must be 'published' to rollback; current status '${row.status}'`,
    );
  }
  const skillId = deriveLearnedSkillId(row);
  const retired = retireLearnedSkill(skillsBase, skillId);
  if (!repo.updateStatus(candidateId, 'published', 'rolled_back')) {
    throw new Error(`skill candidate ${candidateId} status changed concurrently during rollback`);
  }
  const [retiredFrom, archivedTo] = retired ?? [null, null];
  return {
    candidateId,
    status: 'rolled_back',
    skillId,
    retiredFrom,
    archivedTo,
    rolledBackAt: now().rfc3339,
  };
}

// ------------------------------------------------------------------ command helpers

/** ChatV2Error command payload → Rust `Display` text (`Invalid input: …` / `IO error: …`). */
export function commandDisplayMessage(error: unknown): string {
  if (error instanceof CommandError && typeof error.value === 'string') {
    let parsed: unknown;
    try { parsed = JSON.parse(error.value); }
    catch { parsed = undefined; }
    const message = (parsed as { message?: unknown } | undefined)?.message;
    if (typeof message === 'string') return message;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `learned_skills_base`: expand + validate, converting ChatV2Error to Display text. */
export function learnedSkillsBase(files: SkillFiles): string {
  const base = files.expandPath(DEFAULT_AGENT_SKILLS_BASE);
  try { files.validatePath(base); }
  catch (error) { throw new Error(commandDisplayMessage(error)); }
  return base;
}
