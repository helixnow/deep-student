import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import plugin from '../index.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';
import { buildAllowedSkillsBases, commandMentionsSkillsDirectory, stripVerbatimPrefix, normalizePath, SkillFiles } from '../src/files.ts';
import type { PathsService } from '../../../platform/paths/api.ts';

describe('skills.rs filesystem', () => {
  it('skills_dir_deny_matches_windows_backslash_paths', () => {
    for (const command of ['Copy-Item payload.zip C:\\Users\\x\\.deep-student\\skills\\evil\\', 'Set-Content C:\\Users\\x\\.claude\\skills\\evil\\SKILL.md bad', 'dir C:\\Users\\x\\.cursor\\skills-cursor']) expect(commandMentionsSkillsDirectory(command, [])).toBe(true);
  });
  it('skills_dir_deny_matches_forward_slash_and_tilde_paths', () => {
    for (const command of ['cp payload.zip ~/.deep-student/skills/evil/', 'cat ./.agents/skills/foo/SKILL.md', 'ls .github/skills']) expect(commandMentionsSkillsDirectory(command, [])).toBe(true);
  });
  it('skills_dir_deny_is_case_insensitive', () => {
    expect(commandMentionsSkillsDirectory('echo x > C:\\USERS\\X\\.DEEP-STUDENT\\SKILLS\\a\\SKILL.md', [])).toBe(true);
  });
  it('skills_dir_deny_matches_resolved_allowed_bases', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      const skills = host.ctx.agentSkills;
      for (const base of skills.getAllowedSkillsBases()) {
        if (Buffer.byteLength(base) >= 4) expect(skills.commandMentionsSkillsDirectory(`Get-ChildItem "${base}"`)).toBe(true);
      }
    } finally { await host.dispose(); }
  });
  it('skills_dir_deny_ignores_unrelated_commands', () => {
    for (const command of ['git status --short', 'python scripts/convert.py --input data.xlsx', '']) expect(commandMentionsSkillsDirectory(command, [])).toBe(false);
  });
  it('packaged_desktop_app_data_skills_is_an_allowed_base', () => {
    const bases = buildAllowedSkillsBases('home-root', 'desktop-data', 'tauri-app-data', 'project-root', false);
    expect(bases).toContain(path.join('tauri-app-data', '.skills'));
    expect(bases).toContain(path.join('home-root', '.deep-student', 'skills'));
    expect(bases).toContain(path.join('desktop-data', 'deep-student', 'skills'));
    expect(bases).not.toContain(path.join('home-root', '.skills'));
  });
  it('mobile_app_data_skills_is_allowed_without_desktop_data_guessing', () => {
    const bases = buildAllowedSkillsBases('mobile-app-data', 'must-not-be-used', 'mobile-app-data', null, true);
    expect(bases.filter(base => base === path.join('mobile-app-data', '.skills'))).toHaveLength(1);
    expect(bases).not.toContain(path.join('must-not-be-used', 'deep-student', 'skills'));
  });
  it('strip_verbatim_prefix_normalizes_disk_and_unc', () => {
    expect(stripVerbatimPrefix('\\\\?\\C:\\Users\\x\\.deep-student\\skills', 'win32')).toBe('C:\\Users\\x\\.deep-student\\skills');
    expect(stripVerbatimPrefix('\\\\?\\UNC\\server\\share\\skills', 'win32')).toBe('\\\\server\\share\\skills');
    expect(stripVerbatimPrefix('C:\\Users\\x', 'win32')).toBe('C:\\Users\\x');
  });
  it('canonicalized_existing_base_matches_logical_child_path', async () => {
    const host = await createTestHost();
    try {
      const base = stripVerbatimPrefix(await realpath(host.app.dataDir));
      expect(normalizePath(path.join(base, 'new-skill', 'SKILL.md')).startsWith(base + path.sep)).toBe(true);
    } finally { await host.dispose(); }
  });
  it('six filesystem commands retain wire shapes, missing semantics and error ordering', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      let base = path.join(host.app.dataDir, '.skills');
      expect(await host.invoke('skill_list_directories', { path: base })).toEqual([]);
      expect(await host.invoke('skill_list_package_files', { path: path.join(base, 'missing') })).toEqual([]);
      await mkdir(base);
      base = await realpath(base);
      const file = path.join(base, 'demo', 'SKILL.md');
      expect(await host.invoke('skill_create', { basePath: base, skillId: 'demo', content: '# Demo' })).toEqual({ content: '# Demo', path: file });
      expect(await host.invoke('skill_list_directories', { path: base })).toEqual([{ name: 'demo', path: path.dirname(file) }]);
      expect(await host.invoke('skill_read_file', { path: file })).toEqual({ content: '# Demo', path: file });
      expect(await host.invoke('skill_update', { path: file, content: '# 更新' })).toEqual({ content: '# 更新', path: file });
      expect(await host.invoke('skill_list_package_files', { path: path.dirname(file) })).toEqual([{ path: 'SKILL.md', size: Buffer.byteLength('# 更新') }]);
      await expect(host.invoke('skill_create', { basePath: '/not-allowed', skillId: '../bad', content: '' })).rejects.toBe(JSON.stringify({ code: 'INVALID_INPUT', message: 'Invalid input: Skill ID can only contain letters, numbers, hyphens, and underscores' }));
      await expect(host.invoke('skill_create', { basePath: base, skillId: '', content: '' })).rejects.toBe(JSON.stringify({ code: 'INVALID_INPUT', message: 'Invalid input: Skill ID cannot be empty' }));
      expect(await host.invoke('skill_delete', { path: path.dirname(file) })).toBeNull();
      await expect(host.invoke('skill_read_file', { path: file })).rejects.toBe(JSON.stringify({ code: 'RESOURCE_NOT_FOUND', message: `Resource not found: File not found: ${JSON.stringify(file)}` }));
      expect(host.events).toEqual([]);
    } finally { await host.dispose(); }
  });
  it('package traversal follows Rust depth, hidden directory and symlink rules', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      const base = path.join(host.app.dataDir, '.skills');
      await host.invoke('skill_create', { basePath: base, skillId: 'demo', content: '' });
      const root = path.join(base, 'demo');
      for (const folder of ['.hidden', 'node_modules', 'target', 'dist', 'build', 'a/b/c/d/e']) {
        await mkdir(path.join(root, folder), { recursive: true });
        await writeFile(path.join(root, folder, 'ignored'), 'x');
      }
      await writeFile(path.join(root, 'a/b/c/d/kept'), 'x');
      await writeFile(path.join(root, '.visible-file'), 'x');
      await symlink(path.join(root, 'SKILL.md'), path.join(root, 'link'));
      expect(await host.invoke('skill_list_package_files', { path: root })).toEqual([
        { path: '.visible-file', size: 1 }, { path: 'SKILL.md', size: 0 }, { path: 'a/b/c/d/kept', size: 1 },
      ]);
    } finally { await host.dispose(); }
  });
  it('untrusted_skill_script_path_denied_without_skill_dir_gate', () => {
    expect(commandMentionsSkillsDirectory('python ~/.deep-student/skills/evil-pkg/scripts/run.py', [])).toBe(true);
    expect(commandMentionsSkillsDirectory('python C:\\Users\\x\\.deep-student\\skills\\evil-pkg\\scripts\\run.py', [])).toBe(true);
    expect(commandMentionsSkillsDirectory('python scripts/run.py --input notes.md', [])).toBe(false);
  });

  it('warns_on_path_traversal_and_non_directory_branches', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'skills-warn-'));
    try {
      const warnings: string[] = [];
      const files = new SkillFiles(
        { os: { home: root, data: root }, appDataDir: root } as unknown as PathsService,
        { warn: message => warnings.push(message) },
      );
      expect(() => files.validatePath(path.join(root, 'not-allowed', 'SKILL.md'))).toThrow();
      expect(warnings.some(message => message.includes('路径遍历检测'))).toBe(true);

      const base = path.join(root, '.deep-student', 'skills');
      await mkdir(base, { recursive: true });
      const file = path.join(base, 'not-a-directory');
      await writeFile(file, 'x');
      await expect(files.listDirectories(file)).rejects.toThrow(/Path is not a directory/);
      expect(warnings.some(message => message.includes('路径不是目录'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('RF-W02-skills-path-realpath-ancestor: a not-yet-created target under a symlinked base resolves like its realpath-ed base (macOS /var → /private/var)', async () => {
    // On macOS tmpdir() is itself under the /var → /private/var symlink, so this runs the real case there.
    const real = mkdtempSync(path.join(tmpdir(), 'skills-real-'));
    const home = `${real}-home-link`;
    try {
      symlinkSync(real, home, 'dir');
      await mkdir(path.join(real, '.deep-student', 'skills'), { recursive: true });
      const files = new SkillFiles({ os: { home, data: home }, appDataDir: home } as unknown as PathsService, { warn() {} });
      expect(() => files.validatePath(path.join(home, '.deep-student', 'skills', 'demo', 'SKILL.md'))).not.toThrow();
      expect(() => files.validatePath(path.join(home, '.deep-student', 'skills', 'demo'))).not.toThrow();
      const macTemp = mkdtempSync(path.join(tmpdir(), 'skills-tmp-'));
      try {
        await mkdir(path.join(macTemp, '.deep-student', 'skills'), { recursive: true });
        const direct = new SkillFiles({ os: { home: macTemp, data: macTemp }, appDataDir: macTemp } as unknown as PathsService, { warn() {} });
        expect(() => direct.validatePath(path.join(macTemp, '.deep-student', 'skills', 'new-skill', 'SKILL.md'))).not.toThrow();
      } finally { rmSync(macTemp, { recursive: true, force: true }); }
    } finally {
      rmSync(home, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('RF-W02-skills-path-realpath-ancestor: a not-yet-created target behind a symlink that leaves the base is rejected', async () => {
    // realpath-ed so the lexical path and the canonical base agree, isolating the symlink-escape case.
    const root = await realpath(mkdtempSync(path.join(tmpdir(), 'skills-escape-')));
    const outside = await realpath(mkdtempSync(path.join(tmpdir(), 'skills-outside-')));
    try {
      const base = path.join(root, '.deep-student', 'skills');
      await mkdir(base, { recursive: true });
      symlinkSync(outside, path.join(base, 'escape'), 'dir');
      const files = new SkillFiles({ os: { home: root, data: root }, appDataDir: root } as unknown as PathsService, { warn() {} });
      expect(() => files.validatePath(path.join(base, 'escape', 'new', 'SKILL.md'))).toThrow(/Path traversal detected/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
