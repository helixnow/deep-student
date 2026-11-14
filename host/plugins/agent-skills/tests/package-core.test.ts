/**
 * Parity between the Node scanner in `skill-package.ts` and the portable scanner the
 * mobile host runs (`src/mobile/zip.ts`). Both must agree on SKILL.md discovery,
 * extraction order, hashes, risk grading and every rejection message.
 *
 * The shared heuristics (path guards, risk grader) live in `src/package-core.ts`; this
 * suite keeps the two ZIP front-ends honest when that core changes.
 */
import { describe, expect, it } from 'vitest';
import { buildZip, type ZipScanLimits } from '../src/zip.ts';
import { scanSkillZipBytesWithLimits as desktopScan } from '../src/skill-package.ts';
import { isSafeZipEntry } from '../src/package-core.ts';
import { scanSkillZipBytesWithLimits as mobileScan } from '../src/mobile/zip.ts';

const LIMITS: ZipScanLimits = {
  maxEntries: 2000, maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxEntryNameBytes: 1024,
};

function zip(files: Array<[string, string]>): Uint8Array {
  return buildZip(files.map(([name, content]) => ({ name, bytes: new TextEncoder().encode(content) })));
}

async function scanBoth(bytes: Uint8Array, limits: ZipScanLimits = LIMITS) {
  const desktop = (() => desktopScan(bytes, limits))();
  const mobile = await mobileScan(bytes, limits);
  return { desktop, mobile };
}

async function failures(bytes: Uint8Array, limits: ZipScanLimits = LIMITS): Promise<[string, string]> {
  const desktop = (() => { try { desktopScan(bytes, limits); return ''; } catch (error) { return String(error); } })();
  let mobile = '';
  try { await mobileScan(bytes, limits); } catch (error) { mobile = String(error); }
  return [desktop, mobile];
}

describe('package-core parity', () => {
  it('folder package: same skill id, files, hash and risk', async () => {
    const { desktop, mobile } = await scanBoth(zip([
      ['demo/SKILL.md', '---\nname: demo\ndescription: demo skill\n---\n\n# demo\n'],
      ['demo/references/guide.md', '# guide\n'],
      ['demo/scripts/run.sh', 'echo hi\n'],
    ]));
    expect(mobile).toEqual(desktop);
    expect(mobile.skillId).toBe('demo');
    expect(mobile.files.map(([relative]) => relative)).toEqual(['SKILL.md', 'references/guide.md', 'scripts/run.sh']);
    expect(mobile).toMatchObject({ riskLevel: 'medium' });
    expect(mobile.riskSignals).toContain('executable_scripts');
  });

  it('root SKILL.md: frontmatter id overrides the folder fallback', async () => {
    const { desktop, mobile } = await scanBoth(zip([
      ['SKILL.md', '---\nname: root-skill\n---\nbody\n'],
      ['references/guide.md', '# guide\n'],
    ]));
    expect(mobile).toEqual(desktop);
    expect(mobile.skillId).toBe('root-skill');
    expect(mobile.packageSha256).toBe(desktop.packageSha256);
  });

  it('skips unsafe entries identically', async () => {
    const { desktop, mobile } = await scanBoth(zip([
      ['demo/SKILL.md', '---\nname: demo\n---\n'],
      ['demo/node_modules/evil.js', 'x'],
      ['__MACOSX/demo/._SKILL.md', 'junk'],
    ]));
    expect(mobile).toEqual(desktop);
    // node_modules is skipped by `is_safe_zip_entry`; __MACOSX is a safe but non-SKILL entry.
    expect(mobile.files.map(([relative]) => relative)).toEqual(['SKILL.md']);
    expect(isSafeZipEntry('node_modules/evil.js')).toBe(false);
    expect(isSafeZipEntry('__MACOSX/demo/._SKILL.md')).toBe(true);
    expect(isSafeZipEntry('C:/demo/SKILL.md')).toBe(false);
    expect(isSafeZipEntry('demo/..')).toBe(false);
  });

  it('grades shell plus network tools the same way', async () => {
    const { desktop, mobile } = await scanBoth(zip([[
      'demo/SKILL.md',
      '---\nallowed-tools:\n  - local_shell\n  - fetch\n---\n运行 curl 拉取 https://example.com 后处理。\n',
    ]]));
    expect(mobile.riskLevel).toBe(desktop.riskLevel);
    expect(mobile.riskSignals).toEqual(desktop.riskSignals);
    expect(mobile).toMatchObject({ riskLevel: 'high' });
    expect(mobile.riskSignals).toEqual(expect.arrayContaining(['shell_tools', 'network_tools']));
  });

  it('rejects the same malformed packages with the same text', async () => {
    const cases = [
      zip([['demo/notes.md', 'no skill file\n']]),
      zip([['demo bad/SKILL.md', '---\nname: demo\n---\n']]),
      zip([['demo/SKILL.md', '---\nname: demo\n---\n'], ['demo/skill.md', 'duplicate\n']]),
    ];
    for (const bytes of cases) {
      const [desktop, mobile] = await failures(bytes);
      expect(desktop).not.toBe('');
      expect(mobile).toBe(desktop);
    }
  });

  it('enforces entry-count and per-file limits identically', async () => {
    const twoFiles = zip([['demo/SKILL.md', '---\nname: demo\n---\n'], ['demo/guide.md', '# guide\n']]);
    expect(await failures(twoFiles, { ...LIMITS, maxEntries: 1 })).toEqual([
      'Error: Zip contains too many entries (2 > 1)',
      'Error: Zip contains too many entries (2 > 1)',
    ]);
    const [desktop, mobile] = await failures(twoFiles, { ...LIMITS, maxFileBytes: 8 });
    expect(desktop).not.toBe('');
    expect(mobile).toBe(desktop);
    expect(mobile).toMatch(/Zip entry too large: demo\/SKILL\.md/);
  });
});
