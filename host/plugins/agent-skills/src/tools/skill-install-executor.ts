/**
 * Agent skill package self-install tool, ported from
 * `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs`.
 *
 * `skill_scan` is a read-only dry-run; `skill_install` re-fetches the source,
 * verifies the approved SHA-256 and skill id, installs, then records
 * provenance. Both route the post-write trust hand-off through
 * `skill_trust_request`.
 */
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import { namesLoopback } from './fetch-chat-executor.ts';

export const SKILL_SCAN = 'skill_scan';
export const SKILL_INSTALL = 'skill_install';
export const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';
export const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';

export const INSTALL_SUCCESS_MESSAGE =
  'Skill package installed to ~/.deep-student/skills. It is untrusted by default — '
  + 'call skill_trust_request with action=inspect then grant before the skill body injects or '
  + 'package scripts can run via SKILL_DIR. Skills management is only a backup.';

export const POST_WRITE_TRUST_NEXT_STEP =
  'Call skill_trust_request with action=inspect and this skill_id to get the live package_sha256 '
  + 'and risk_level; explain the reason and risk summary to the user, then call skill_trust_request '
  + 'with action=grant using expected_package_sha256 set to package_sha256 and declared_risk_level '
  + 'set to risk_level from inspect. Grant requires user approval and cannot be remembered. Skills '
  + 'management UI is only a backup. After grant succeeds, do not call load_skills in the same tool '
  + 'loop: this request keeps its pre-grant runtime catalog snapshot, and the skill becomes loadable '
  + 'on the next user turn.';

/** `safe_truncate`: first `maxChars` Unicode scalars plus `...` when cut. */
export function safeTruncate(input: string, maxChars: number): string {
  if (maxChars === 0) return '';
  const chars = Array.from(input);
  if (chars.length <= maxChars) return input;
  return `${chars.slice(0, maxChars).join('')}...`;
}

export interface ParsedSource {
  kind: 'url' | 'runtime_path';
  detail: string;
  summary: string;
}

export class SkillInstallExecutor {
  static stripNamespace(toolName: string): string {
    if (toolName.startsWith('builtin-')) return toolName.slice(8);
    if (toolName.startsWith('mcp_')) return toolName.slice(4);
    return toolName;
  }

  static riskRank(level: string): number {
    const normalized = level.toLowerCase();
    if (normalized === 'high') return 3;
    if (normalized === 'medium') return 2;
    return 1;
  }

  static sha256Hex(bytes: Uint8Array): string {
    return sha256HexSync(bytes);
  }

  static normalizeSha256(raw: string): string {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed.length !== 64 || !/^[0-9a-f]{64}$/.test(trimmed)) {
      throw new Error('expected_sha256 must be a 64-character hex SHA-256 digest');
    }
    return trimmed;
  }

  static expectedSkillId(args: unknown): string {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown> : {};
    const raw = record.skill_id ?? record.skillId;
    const skillId = typeof raw === 'string' ? raw.trim() : '';
    if (skillId === '') throw new Error('skill_id is required (use skill_id from skill_scan)');
    return skillId;
  }

  static verifyExpectedSkillId(expected: string, actual: string): void {
    if (expected === actual) return;
    throw new Error(
      `Skill target mismatch: approval expected skill_id '${expected}', but the scanned package `
      + `installs '${actual}'. Run skill_scan again and use its exact skill_id.`,
    );
  }

  static parseSource(args: unknown): ParsedSource {
    const record = typeof args === 'object' && args !== null && !Array.isArray(args)
      ? args as Record<string, unknown> : {};
    const source = record.source;
    if (typeof source !== 'object' || source === null || Array.isArray(source)) {
      throw new Error('source is required ({ url } or { root_id, path })');
    }
    const sourceRecord = source as Record<string, unknown>;
    if (typeof sourceRecord.url === 'string') {
      const trimmed = sourceRecord.url.trim();
      if (trimmed === '') throw new Error('source.url must not be empty');
      let parsed: URL;
      try { parsed = new URL(trimmed); }
      catch (error) {
        throw new Error(`Invalid source.url: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (parsed.protocol !== 'https:') {
        throw new Error('source.url must use https:// (http and other schemes are blocked)');
      }
      return { kind: 'url', detail: trimmed, summary: safeTruncate(trimmed, 80) };
    }

    const rawRoot = sourceRecord.root_id ?? sourceRecord.rootId;
    const rootId = typeof rawRoot === 'string' ? rawRoot.trim() : '';
    if (rootId === '') throw new Error('source must include url or root_id + path');
    const rawPath = sourceRecord.path;
    const sourcePath = typeof rawPath === 'string' ? rawPath.trim() : '';
    if (sourcePath === '') throw new Error('source.path is required when using root_id');

    const rootLower = rootId.toLowerCase();
    if (rootLower !== 'temp' && rootLower !== 'artifacts') {
      throw new Error(`source.root_id must be temp or artifacts, got '${rootId}'`);
    }
    const summary = `${rootLower}:${sourcePath.replaceAll('\\', '/')}`;
    return { kind: 'runtime_path', detail: summary, summary };
  }

  canHandle(toolName: string): boolean {
    const stripped = SkillInstallExecutor.stripNamespace(toolName);
    return stripped === SKILL_SCAN || stripped === SKILL_INSTALL;
  }

  sensitivityLevel(toolName: string): 'low' | 'high' {
    return SkillInstallExecutor.stripNamespace(toolName) === SKILL_INSTALL ? 'high' : 'low';
  }

  // RUST-FIX(RF-W02-skill-scan-loopback-approval): Rust keeps skill_scan Low for any URL, so a loopback URL probes local services without approval
  sensitivityLevelForCall(toolName: string, args: unknown): 'low' | 'high' {
    const source = typeof args === 'object' && args !== null ? (args as Record<string, unknown>).source : undefined;
    const url = typeof source === 'object' && source !== null ? (source as Record<string, unknown>).url : undefined;
    return typeof url === 'string' && namesLoopback(url.trim()) ? 'high' : this.sensitivityLevel(toolName);
  }

  hasDynamicSensitivity(toolName: string): boolean {
    return SkillInstallExecutor.stripNamespace(toolName) === SKILL_SCAN;
  }

  name(): string {
    return 'SkillInstallExecutor';
  }
}
