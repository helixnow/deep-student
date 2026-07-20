import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

import {
  skillMarketDownloadAndScan,
  installTapSkill,
  type SkillMarketDownloadScanResult,
  type SkillPackageScanResult,
  updateSkillFromSource,
} from '../api';
import { getSkillTrustOverride, setSkillTrustOverride } from '../skillTrustStorage';
import type { SkillDefinition } from '../types';

const untrustedSkill: SkillDefinition = {
  id: 'evil-scripts',
  name: 'evil-scripts',
  description: 'Untrusted package with scripts',
  version: '0.1.0',
  content: '---\nname: evil-scripts\n---\nBody',
  location: 'global',
  sourcePath: '/tmp/skills/evil-scripts/SKILL.md',
  packageRoot: '/tmp/skills/evil-scripts',
  trustStatus: 'untrusted',
  embeddedTools: [],
};

describe('install trust chain (scan risk + trust gate)', () => {
  beforeEach(() => {
    localStorage.clear();
    invokeMock.mockReset();
  });

  it('dry_run / scan surfaces risk_level and risk_signals before install', async () => {
    const scan: SkillPackageScanResult = {
      skill_id: 'evil-scripts',
      path: '/tmp/skills/evil-scripts',
      files_extracted: 2,
      scripts_count: 1,
      references_count: 0,
      allowed_tools_count: 1,
      package_sha256: 'b'.repeat(64),
      risk_level: 'high',
      risk_signals: [
        'executable_scripts',
        'shell_tools',
        'prompt_injection',
      ],
    };
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'skill_tap_install') return scan;
      throw new Error(`unexpected invoke: ${cmd}`);
    });

    const result = await installTapSkill({
      zipUrl: 'https://example.com/skills.zip',
      subdir: 'evil-scripts',
      overwrite: false,
      dryRun: true,
      expectedPackageSha256: null,
    });

    expect(invokeMock).toHaveBeenCalledWith('skill_tap_install', {
      zipUrl: 'https://example.com/skills.zip',
      subdir: 'evil-scripts',
      overwrite: false,
      dryRun: true,
      expectedPackageSha256: null,
    });
    expect(result.risk_level).toBe('high');
    expect(result.risk_signals).toEqual(
      expect.arrayContaining([
        'executable_scripts',
        'shell_tools',
        'prompt_injection',
      ]),
    );
    expect(result.package_sha256).toHaveLength(64);
    // 装前扫描不得暗示已信任
    expect(result).not.toHaveProperty('trust_status', 'trusted');
  });

  it('skill_market download_and_scan (install=false) exposes scan risk for user confirmation', async () => {
    const payload: SkillMarketDownloadScanResult = {
      slug: 'sonoscli',
      version: '1.0.0',
      provenance: 'skill_market:sonoscli@1.0.0',
      tempZipPath: '/tmp/sonoscli.zip',
      sourceKind: 'zip',
      installed: false,
      scan: {
        skill_id: 'sonoscli',
        path: '~/.deep-student/skills/sonoscli',
        files_extracted: 3,
        scripts_count: 1,
        references_count: 1,
        allowed_tools_count: 2,
        package_sha256: 'c'.repeat(64),
        risk_level: 'medium',
        risk_signals: ['executable_scripts', 'external_urls'],
      },
    };
    invokeMock.mockResolvedValueOnce(payload);

    const result = await skillMarketDownloadAndScan({
      slug: 'sonoscli',
      version: '1.0.0',
      install: false,
    });

    expect(invokeMock).toHaveBeenCalledWith('skill_market_download_and_scan', {
      slug: 'sonoscli',
      version: '1.0.0',
      install: false,
      overwrite: false,
      expectedPackageSha256: null,
      tempZipPath: null,
    });
    expect(result.installed).toBe(false);
    expect(result.scan.risk_level).toBe('medium');
    expect(result.scan.risk_signals).toContain('executable_scripts');
    expect(result.provenance).toBe('skill_market:sonoscli@1.0.0');
  });

  it('untrusted skill cannot become trusted when backend rejects', async () => {
    invokeMock.mockRejectedValueOnce(new Error("Skill 'evil-scripts' is not trusted by the backend"));

    await expect(
      setSkillTrustOverride(untrustedSkill.id, 'trusted', untrustedSkill),
    ).rejects.toThrow(/not trusted/i);
    expect(getSkillTrustOverride(untrustedSkill.id)).toBeNull();
    // UI 侧仍保持无本地信任覆盖 → 不会经 SKILL_DIR 放行脚本
    expect(untrustedSkill.trustStatus).toBe('untrusted');
  });

  it('update from source resets trust_status to untrusted', async () => {
    invokeMock.mockResolvedValueOnce({
      skillId: 'sonoscli',
      updated: true,
      packageSha256: 'd'.repeat(64),
      riskLevel: 'medium',
      path: '~/.deep-student/skills/sonoscli',
      trustStatus: 'untrusted',
    });

    const result = await updateSkillFromSource('sonoscli');
    expect(result.updated).toBe(true);
    expect(result.trustStatus).toBe('untrusted');
    expect(result.riskLevel).toBe('medium');
  });
});
