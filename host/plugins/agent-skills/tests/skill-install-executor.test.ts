import { describe, expect, it } from 'vitest';
import {
  INSTALL_SUCCESS_MESSAGE, POST_WRITE_TRUST_NEXT_STEP, SkillInstallExecutor,
} from '../src/tools/skill-install-executor.ts';

describe('skill_install_executor.rs', () => {
  it('risk_rank_orders_levels', () => {
    expect(SkillInstallExecutor.riskRank('high')).toBeGreaterThan(SkillInstallExecutor.riskRank('medium'));
    expect(SkillInstallExecutor.riskRank('medium')).toBeGreaterThan(SkillInstallExecutor.riskRank('low'));
  });

  it('parse_url_source_requires_https', () => {
    expect(() => SkillInstallExecutor.parseSource({
      source: { url: 'http://example.com/pkg.zip' },
    })).toThrow();
    const parsed = SkillInstallExecutor.parseSource({
      source: { url: 'https://example.com/pkg.zip' },
    });
    expect(parsed.kind).toBe('url');
  });

  it('parse_runtime_source_only_allows_temp_and_artifacts', () => {
    expect(() => SkillInstallExecutor.parseSource({
      source: { root_id: 'workspace', path: 'x.zip' },
    })).toThrow();
    const parsed = SkillInstallExecutor.parseSource({
      source: { root_id: 'temp', path: 'attachments/pkg.zip' },
    });
    expect(parsed.kind).toBe('runtime_path');
    expect(parsed.summary).toContain('temp:');
  });

  it('normalize_sha256_rejects_invalid', () => {
    expect(() => SkillInstallExecutor.normalizeSha256('abc')).toThrow();
    expect(() => SkillInstallExecutor.normalizeSha256(
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    )).not.toThrow();
  });

  it('expected_skill_id_must_match_scanned_package_target', () => {
    expect(() => SkillInstallExecutor.verifyExpectedSkillId('reviewed', 'reviewed')).not.toThrow();
    expect(() => SkillInstallExecutor.verifyExpectedSkillId('reviewed', 'different'))
      .toThrow("approval expected skill_id 'reviewed'");
  });

  it('url_source_summary_truncates_multibyte_text_without_panicking', () => {
    const url = `https://example.com/${'a'.repeat(70)}中文`;
    const parsed = SkillInstallExecutor.parseSource({ source: { url } });
    expect(Buffer.byteLength(parsed.summary, 'utf8')).toBeGreaterThan(0);
    expect(Array.from(parsed.summary).length).toBeLessThanOrEqual(83);
    expect(parsed.summary.endsWith('...')).toBe(true);
  });

  it('install_success_narrative_routes_through_skill_trust_request', () => {
    expect(INSTALL_SUCCESS_MESSAGE).toContain('skill_trust_request');
    expect(INSTALL_SUCCESS_MESSAGE).toContain('action=inspect then grant');
    expect(INSTALL_SUCCESS_MESSAGE).toContain('Skills management is only a backup');
    expect(INSTALL_SUCCESS_MESSAGE).not.toContain(
      'user must trust it in Skills management',
    );

    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('skill_trust_request');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('action=inspect');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('action=grant');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('expected_package_sha256');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('declared_risk_level');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('Skills management UI is only a backup');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain(
      'After grant succeeds, do not call load_skills',
    );
  });
});
