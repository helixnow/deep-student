/**
 * 移动端 G09 技能候选：列表 / 重放 / 晋升 / 回滚。
 *
 * 数据库状态机与漂移探针在 `skill-replay-core.ts`（与桌面共用）。这里只补技能目录写入：
 * - 晋升：读现有 `SKILL.md` 的 frontmatter 血缘，版本 +1 后写 `SKILL.md` + `AGENT_INSTALLED.json`；
 * - 回滚：把技能目录复制进 `.archive/<id>.rolledback-<stamp>` 后删除原目录——OPFS 目录没有
 *   `move()`，不能像桌面那样一次 rename 完成退役。
 */
import type { FilesService } from '../../../../platform/files/api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import type { SkillCandidatePromotion, SkillCandidateRollback } from '../../api.ts';
import { now } from '../../../../platform/time/index.ts';
import { posix } from '../../../../platform/util/path.ts';
import { SkillCandidateRepo } from '../../repository/skill-usage.ts';
import type { SkillCandidateRow } from '../../repository/skill-usage.ts';
import {
  G09_FRONTMATTER_SOURCE, SKILL_ARCHIVE_SUBDIR, SKILL_FILE_NAME, archiveStamp, buildLearnedSkillDraft,
  deriveLearnedSkillId, learnedSkillMarker, parseInstalledLineage,
} from '../skill-replay-core.ts';
import { debugPath, MobileSkillPaths } from './paths.ts';
import { ioMessage } from './files.ts';

const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';

export async function readInstalledLineageMobile(files: FilesService, skillFile: string) {
  let stat;
  try { stat = await files.stat(skillFile); }
  catch { return undefined; }
  if (stat.kind !== 'file') return undefined;
  let bytes: Uint8Array;
  try { bytes = await files.readBytes(skillFile); }
  catch (error) { throw new Error(`failed to read installed skill ${debugPath(skillFile)}: ${ioMessage(error)}`); }
  let content: string;
  try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch (error) { throw new Error(`failed to read installed skill ${debugPath(skillFile)}: ${ioMessage(error)}`); }
  return parseInstalledLineage(content);
}

interface InstalledLearnedSkill {
  skillId: string;
  skillFilePath: string;
  version: number;
  written: boolean;
}

async function installLearnedSkill(
  files: FilesService,
  skillsBase: string,
  row: SkillCandidateRow,
): Promise<InstalledLearnedSkill> {
  let version = 1;
  let draft = buildLearnedSkillDraft(row, version);
  const skillDir = posix.join(skillsBase, draft.skillId);
  const skillFile = posix.join(skillDir, SKILL_FILE_NAME);

  const lineage = await readInstalledLineageMobile(files, skillFile);
  if (lineage !== undefined) {
    if (lineage.source !== G09_FRONTMATTER_SOURCE) {
      throw new Error(
        `skill id collision: ${debugPath(skillFile)} exists but is not a G09-learned skill; refusing to overwrite`,
      );
    }
    if (lineage.traceHash === row.traceHash) {
      return { skillId: draft.skillId, skillFilePath: skillFile, version: lineage.version ?? 1, written: false };
    }
    version = Math.max(1, (lineage.version ?? 0) + 1);
    draft = buildLearnedSkillDraft(row, version);
  }

  const { marker } = learnedSkillMarker(row, draft, version);
  try {
    await files.mkdir(skillDir, { recursive: true });
    await files.writeBytes(skillFile, new TextEncoder().encode(draft.markdown), { createParents: true });
    await files.writeBytes(
      posix.join(skillDir, AGENT_INSTALLED_MARKER),
      new TextEncoder().encode(JSON.stringify(marker, null, 2)),
      { createParents: true },
    );
  } catch (error) {
    throw new Error(`Failed to write learned skill ${debugPath(skillDir)}: ${ioMessage(error)}`);
  }
  return { skillId: draft.skillId, skillFilePath: skillFile, version, written: true };
}

/** Promote a validated (`passed`) candidate to `published` and write SKILL.md. */
export async function promoteCandidateMobile(
  db: SqlExecutor,
  candidateId: string,
  skillsBase: string,
  files: FilesService,
): Promise<SkillCandidatePromotion> {
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

  if (row.status === 'published') {
    const skillId = deriveLearnedSkillId(row);
    const skillFile = posix.join(skillsBase, skillId, SKILL_FILE_NAME);
    const lineage = await readInstalledLineageMobile(files, skillFile);
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
    const installed = await installLearnedSkill(files, skillsBase, row);
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

  const installed = await installLearnedSkill(files, skillsBase, row);
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

async function copyDirectory(files: FilesService, from: string, to: string): Promise<void> {
  await files.mkdir(to, { recursive: true });
  for await (const entry of files.walk(from)) {
    if (entry.kind !== 'file') continue;
    const bytes = await files.readBytes(entry.path);
    await files.writeBytes(posix.join(to, entry.relativePath), bytes, { createParents: true });
  }
}

/** 退役习得技能目录：复制进 `<skills_base>/.archive/` 后删除原目录（不物理丢弃内容）。 */
export async function retireLearnedSkillMobile(
  files: FilesService,
  skillsBase: string,
  skillId: string,
): Promise<[string, string] | undefined> {
  const skillDir = posix.join(skillsBase, skillId);
  if (!await files.exists(skillDir)) return undefined;
  const lineage = await readInstalledLineageMobile(files, posix.join(skillDir, SKILL_FILE_NAME));
  if (lineage === undefined || lineage.source !== G09_FRONTMATTER_SOURCE) {
    throw new Error(
      `refusing to retire non-G09 skill directory ${debugPath(skillDir)} (lineage missing or diverged)`,
    );
  }
  const archiveRoot = posix.join(skillsBase, SKILL_ARCHIVE_SUBDIR);
  try { await files.mkdir(archiveRoot, { recursive: true }); }
  catch (error) { throw new Error(`failed to create skill archive dir ${debugPath(archiveRoot)}: ${ioMessage(error)}`); }
  const archived = posix.join(archiveRoot, `${skillId}.rolledback-${archiveStamp()}`);
  try {
    await copyDirectory(files, skillDir, archived);
    await files.rm(skillDir, { recursive: true });
  } catch (error) {
    throw new Error(
      `failed to retire skill directory ${debugPath(skillDir)} -> ${debugPath(archived)}: ${ioMessage(error)}`,
    );
  }
  return [skillDir, archived];
}

/** Move a `published` candidate to `rolled_back` and archive its skill directory. */
export async function rollbackCandidateMobile(
  db: SqlExecutor,
  candidateId: string,
  skillsBase: string,
  files: FilesService,
): Promise<SkillCandidateRollback> {
  const repo = new SkillCandidateRepo(db);
  const row = repo.get(candidateId);
  if (row === undefined) throw new Error(`skill candidate not found: ${candidateId}`);
  if (row.status !== 'published') {
    throw new Error(
      `skill candidate ${candidateId} must be 'published' to rollback; current status '${row.status}'`,
    );
  }
  const skillId = deriveLearnedSkillId(row);
  const retired = await retireLearnedSkillMobile(files, skillsBase, skillId);
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

/** `learned_skills_base`: expand + validate, converting the command envelope to Display text. */
export function learnedSkillsBase(paths: MobileSkillPaths): string {
  try { return paths.validateSkillPath('~/.deep-student/skills'); }
  catch (error) { throw new Error(commandDisplayMessage(error)); }
}

/** ChatV2Error command payload → Rust `Display` text (`Invalid input: …` / `IO error: …`). */
export function commandDisplayMessage(error: unknown): string {
  const value = (error as { value?: unknown }).value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as { message?: unknown };
      if (typeof parsed.message === 'string') return parsed.message;
    } catch { /* boundary-allow empty-catch: not the command envelope */ }
  }
  return error instanceof Error ? error.message : String(error);
}
