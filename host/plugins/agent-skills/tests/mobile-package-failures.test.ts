import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import { MobilePreparedSkillPackage } from '../src/mobile/package.ts';
import type { SkillImportZipResult } from '../api.ts';

const base = '/deep-student/skills';
const live = `${base}/demo`;
const staging = `${base}/.demo.staging-test`;
const result = { skill_id: 'demo', path: live } as SkillImportZipResult;

describe('mobile skill publish failure recovery', () => {
  let files: ReturnType<typeof createOpfsFiles>;
  beforeEach(async () => {
    files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots('/deep-student') });
    await files.writeText(`${staging}/SKILL.md`, 'new', { createParents: true });
    await files.writeText(`${staging}/extra.txt`, 'new extra');
  });

  function failWriteOnce(path: string) {
    const write = files.writeBytes.bind(files);
    let failed = false;
    vi.spyOn(files, 'writeBytes').mockImplementation(async (target, bytes, options) => {
      if (target === path && !failed) { failed = true; throw new Error('disk full'); }
      return write(target, bytes, options);
    });
  }

  it('removes a partially published first-time install', async () => {
    failWriteOnce(`${live}/extra.txt`);
    const prepared = new MobilePreparedSkillPackage(files, result, staging, live, false);
    await expect(prepared.commit()).rejects.toThrow('Failed to publish staged skill');
    expect(await files.exists(live)).toBe(false);
    await prepared.dispose();
  });

  it('restores the previous package and removes its backup after a failed overwrite', async () => {
    await files.writeText(`${live}/SKILL.md`, 'old', { createParents: true });
    await files.mkdir(`${live}/empty`, { recursive: true });
    failWriteOnce(`${live}/extra.txt`);
    const prepared = new MobilePreparedSkillPackage(files, result, staging, live, true);
    await expect(prepared.commit()).rejects.toThrow('Failed to publish staged skill');
    expect(await files.readText(`${live}/SKILL.md`)).toBe('old');
    expect(await files.exists(`${live}/extra.txt`)).toBe(false);
    expect(await files.exists(`${live}/empty`)).toBe(true);
    expect((await files.readDir(base)).some(entry => entry.name.includes('.backup-'))).toBe(false);
    await prepared.dispose();
  });

  it('does not merge new files into a package whose removal failed', async () => {
    await files.writeText(`${live}/SKILL.md`, 'old', { createParents: true });
    const rm = files.rm.bind(files);
    vi.spyOn(files, 'rm').mockImplementation(async (target, options) => {
      if (target === live) throw new Error('locked');
      return rm(target, options);
    });
    const prepared = new MobilePreparedSkillPackage(files, result, staging, live, true);
    await expect(prepared.commit()).rejects.toThrow('Failed to remove existing skill');
    expect(await files.readText(`${live}/SKILL.md`)).toBe('old');
    expect(await files.exists(`${live}/extra.txt`)).toBe(false);
    await prepared.dispose();
  });

  it('cleans up a partial backup without touching the original when backup copying fails', async () => {
    await files.writeText(`${live}/SKILL.md`, 'old', { createParents: true });
    await files.writeText(`${live}/extra.txt`, 'old extra');
    const read = files.readBytes.bind(files);
    vi.spyOn(files, 'readBytes').mockImplementation(async (target, options) => {
      if (target === `${live}/extra.txt`) throw new Error('read failed');
      return read(target, options);
    });
    const prepared = new MobilePreparedSkillPackage(files, result, staging, live, true);
    await expect(prepared.commit()).rejects.toThrow('to rollback backup: read failed');
    expect(await files.readText(`${live}/SKILL.md`)).toBe('old');
    expect((await files.readDir(base)).some(entry => entry.name.includes('.backup-'))).toBe(false);
    await prepared.dispose();
  });

  it('keeps the recovery backup when rollback cannot remove the live package', async () => {
    await files.writeText(`${live}/SKILL.md`, 'old', { createParents: true });
    const prepared = new MobilePreparedSkillPackage(files, result, staging, live, true);
    const [, committed] = await prepared.commit();
    const rm = files.rm.bind(files);
    const spy = vi.spyOn(files, 'rm').mockImplementation(async (target, options) => {
      if (target === live) throw new Error('locked');
      return rm(target, options);
    });
    await expect(committed.rollback()).rejects.toThrow('locked');
    expect((await files.readDir(base)).some(entry => entry.name.includes('.backup-'))).toBe(true);
    spy.mockRestore();
    await committed.rollback();
    expect(await files.readText(`${live}/SKILL.md`)).toBe('old');
    await prepared.dispose();
  });
});
