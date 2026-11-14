import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  decodeTapSourceDetail, encodeTapSourceDetail, repackSkillSubdir, repoNameFromZipUrl,
  resolveCodeloadCandidates, scanRepoZipForCatalog, validateTapExportDestination, writeTapExportZip,
  SkillTaps,
} from '../src/skill-taps.ts';
import { buildZip, readZipEntries } from '../src/zip.ts';
import { SkillFiles } from '../src/files.ts';
import { SkillPackages } from '../src/skill-package.ts';
import type { PathsService } from '../../../platform/paths/api.ts';

const buildRepoZip = (files: Array<[string, string]>): Uint8Array =>
  buildZip(files.map(([name, content]) => ({ name, bytes: Buffer.from(content) })));

const REPO = 'my-skills-main/';
function sampleRepo(): Uint8Array {
  return buildRepoZip([
    [`${REPO}skills/pdf-tools/SKILL.md`, '---\nname: PDF 工具\ndescription: 处理 PDF\nversion: 1.2.0\n---\n\n# body\n'],
    [`${REPO}skills/pdf-tools/scripts/run.py`, "print('hi')\n"],
    [`${REPO}skills/note-taker/SKILL.md`, '---\nname: "Note Taker"\ndescription: takes notes\n---\nbody\n'],
    [`${REPO}README.md`, '# readme\n'],
    [`${REPO}.github/workflows/ci.yml`, 'on: push\n'],
  ]);
}

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ds-taps-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true }); });

describe('skill_taps.rs', () => {
  it('resolves_repo_url_to_codeload_candidates', () => {
    const candidates = resolveCodeloadCandidates('https://github.com/foo/bar');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain('/foo/bar/zip/refs/heads/main');
    expect(candidates[1]).toContain('/foo/bar/zip/refs/heads/master');
    expect(resolveCodeloadCandidates('https://github.com/foo/bar/tree/dev'))
      .toEqual(['https://codeload.github.com/foo/bar/zip/dev']);
    expect(() => resolveCodeloadCandidates('https://gitlab.com/foo/bar')).toThrow();
    expect(() => resolveCodeloadCandidates('https://github.com/foo')).toThrow();
  });

  it('catalog_lists_skills_and_skips_hidden_dirs', () => {
    const entries = scanRepoZipForCatalog(sampleRepo());
    expect(entries).toHaveLength(2);
    expect(entries[0]!.skillId).toBe('note-taker');
    expect(entries[0]!.name).toBe('Note Taker');
    expect(entries[1]!.skillId).toBe('pdf-tools');
    expect(entries[1]!.name).toBe('PDF 工具');
    expect(entries[1]!.version).toBe('1.2.0');
    expect(entries[1]!.fileCount).toBe(2);
  });

  it('repack_is_deterministic_and_canonical', () => {
    const repo = sampleRepo();
    const a = repackSkillSubdir(repo, 'skills/pdf-tools', 'fallback');
    const b = repackSkillSubdir(repo, 'skills/pdf-tools', 'fallback');
    expect(Buffer.from(a)).toEqual(Buffer.from(b));
    const names = readZipEntries(a).map(entry => entry.name).sort();
    expect(names).toEqual(['pdf-tools/SKILL.md', 'pdf-tools/scripts/run.py']);
  });

  it('repack_rejects_missing_subdir', () => {
    expect(() => repackSkillSubdir(sampleRepo(), 'skills/nope', 'fb')).toThrow();
  });

  it('tap_export_destination_accepts_opaque_content_uri_only_for_virtual', () => {
    expect(validateTapExportDestination('content://com.android.providers.downloads.documents/document/446')).toBe(true);
    expect(validateTapExportDestination('/tmp/my-skills-tap.zip')).toBe(false);
    expect(() => validateTapExportDestination('/tmp/my-skills-tap')).toThrow();
    expect(() => validateTapExportDestination('/tmp/my-skills-tap.txt')).toThrow();
    expect(() => validateTapExportDestination('content%3A%2F%2Fcom.android.providers.downloads.documents%2Fdocument%2F446.zip')).toThrow();
  });

  it('tap_export_virtual_destination_goes_through_staging_and_cleans_up', async () => {
    const staging = tempDir();
    const target = 'content://com.android.externalstorage.documents/document/primary%3Atap';
    let seen: { dest: string; bytes: Buffer } | null = null;
    const written = await writeTapExportZip(Buffer.from('PK\u0003\u0004zip'), target, true, staging, (staged, dest) => {
      seen = { dest, bytes: readFileSync(staged) };
    });
    expect(written).toBe(target);
    expect(seen).not.toBeNull();
    expect(seen!.dest).toBe(target);
    expect(seen!.bytes).toEqual(Buffer.from('PK\u0003\u0004zip'));
    expect(readdirSync(staging)).toHaveLength(0);

    await expect(writeTapExportZip(Buffer.from('PK'), target, true, staging, () => { throw new Error('provider refused'); }))
      .rejects.toThrow(/provider refused/);
    expect(readdirSync(staging)).toHaveLength(0);
  });

  it('tap_export_local_destination_writes_directly', async () => {
    const dir = tempDir();
    const dest = path.join(dir, 'tap.zip');
    const written = await writeTapExportZip(Buffer.from('PK'), dest, false, path.join(dir, 'staging'), () => {
      throw new Error('local destinations must not use write_virtual');
    });
    expect(written).toBe(dest);
    expect(readFileSync(dest)).toEqual(Buffer.from('PK'));
    expect(() => readdirSync(path.join(dir, 'staging'))).toThrow();
  });

  it('L07-05 tap export write yields to the Host event loop and keeps local bytes', async () => {
    const dir = tempDir();
    const dest = path.join(dir, 'tap.zip');
    let immediateRan = false;
    setImmediate(() => { immediateRan = true; });
    const written = await writeTapExportZip(Buffer.from('PK'), dest, false, path.join(dir, 'staging'), () => {
      throw new Error('local destinations must not use write_virtual');
    });
    expect(written).toBe(dest);
    expect(readFileSync(dest)).toEqual(Buffer.from('PK'));
    expect(immediateRan).toBe(true);
  });

  it('tap_detail_roundtrip', () => {
    const detail = encodeTapSourceDetail('https://codeload.github.com/foo/bar/zip/refs/heads/main', 'skills/pdf-tools');
    const [url, subdir] = decodeTapSourceDetail(detail);
    expect(url).toBe('https://codeload.github.com/foo/bar/zip/refs/heads/main');
    expect(subdir).toBe('skills/pdf-tools');
  });
});

describe('skill_taps.rs helpers', () => {
  it('repo_name_from_zip_url_sanitizes_repo_segment', () => {
    expect(repoNameFromZipUrl('https://codeload.github.com/foo/my.skills/zip/main')).toBe('my-skills');
    expect(repoNameFromZipUrl('https://codeload.github.com/')).toBe('imported-skill');
  });

  it('export_tap_archives_skill_files_through_worker', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tap-export-'));
    tempDirs.push(root);
    const files = new SkillFiles(
      { os: { home: root, data: root }, appDataDir: root } as unknown as PathsService,
    );
    const packages = new SkillPackages(files);
    const taps = new SkillTaps(files, packages, root, () => null, { warn: () => undefined });
    const base = files.expandPath('~/.deep-student/skills');
    mkdirSync(path.join(base, 'demo', 'references'), { recursive: true });
    writeFileSync(path.join(base, 'demo', 'SKILL.md'), '---\nname: Demo\ndescription: d\nversion: 2.0.0\n---\nbody\n');
    writeFileSync(path.join(base, 'demo', 'references', 'guide.md'), 'guide\n');
    writeFileSync(path.join(base, 'demo', 'AGENT_INSTALLED.json'), '{}');
    const dest = path.join(root, 'tap.zip');
    const result = await taps.exportTap(['demo'], dest, () => {
      throw new Error('local destination must not use virtual writer');
    });
    expect(result).toEqual({ path: dest, skillCount: 1, fileCount: 3 });
    const entries = readZipEntries(readFileSync(dest));
    expect(entries.map(entry => entry.name)).toEqual([
      'demo/SKILL.md', 'demo/references/guide.md', 'README.md',
    ]);
    const readme = readFileSync(dest);
    expect(Buffer.from(readme).toString('latin1')).toContain('README.md');
  });
});
