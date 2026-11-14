import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { memorySettings, unavailableStorage } from './platform-stubs.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
import {
  extractFrontmatter, parseRequires, pythonImportName, probeSearchDirs,
  probeBinInDirs, probeBin, partitionRequires, formatMissingRequiresHints,
} from '../src/requires.ts';

describe('skill_requires.rs', () => {
  it('parse_top_level_requires_lists', () => {
    expect(parseRequires(`---
name: Demo
description: Demo skill for requires parsing
requires:
  bins:
    - python
    - pandoc
  env:
    - OPENAI_API_KEY
  python_packages:
    - pymupdf
---

# body
`)).toEqual({ bins: ['python', 'pandoc'], env: ['OPENAI_API_KEY'], python_packages: ['pymupdf'] });
  });
  it('parse_top_level_requires_inline_arrays', () => {
    expect(parseRequires(`---
name: Demo
description: Demo skill for requires parsing
requires:
  bins: [node, uv]
  env: [API_KEY, OTHER_ENV]
  python_packages: [pymupdf, pillow]
---
`)).toEqual({ bins: ['node', 'uv'], env: ['API_KEY', 'OTHER_ENV'], python_packages: ['pymupdf', 'pillow'] });
  });
  it('parse_missing_frontmatter_returns_empty', () => {
    expect(parseRequires('# no frontmatter\n')).toEqual({ bins: [], env: [], python_packages: [] });
  });
  it('frontmatter_delimiters_must_occupy_their_own_line', () => {
    expect(extractFrontmatter('---suffix\nname: Demo\n---\n')).toBeNull();
    expect(extractFrontmatter('---\nname: Demo\n---suffix\n# body\n')).toBeNull();
    expect(extractFrontmatter('---\nname: Demo\n\t--- \r\n# body\n')).toBeNull();
    expect(extractFrontmatter('  ---  \r\nname: Demo\r\n--- \r\n# body\n')).toBe('name: Demo');
  });
  it('parses_flow_map_and_openclaw_nested_requires', () => {
    expect(parseRequires('---\nname: Demo\nrequires: {bins: [node, uv], env: [API_KEY], python_packages: [pymupdf]}\n---\n'))
      .toEqual({ bins: ['node', 'uv'], env: ['API_KEY'], python_packages: ['pymupdf'] });
    expect(parseRequires('---\nname: Demo\nmetadata:\n  openclaw:\n    requires:\n      bins: [rg]\n      env:\n        - SEARCH_TOKEN\n      python_packages:\n        - pillow\n---\n'))
      .toEqual({ bins: ['rg'], env: ['SEARCH_TOKEN'], python_packages: ['pillow'] });
  });
  it('python_import_name_maps_common_packages', () => {
    for (const [input, output] of [['pymupdf', 'fitz'], ['PyMuPDF', 'fitz'], ['pillow', 'PIL'], ['scikit-learn', 'sklearn'], ['requests', 'requests'], ['python-dateutil', 'dateutil']]) {
      expect(pythonImportName(input!)).toBe(output);
    }
  });
  it('probe_search_path_includes_gui_install_locations_without_shell_profiles', () => {
    const home = '/tmp/deep-student-home';
    const dirs = probeSearchDirs(['/custom/bin', '/usr/bin'].join(path.delimiter), home);
    expect(dirs).toContain('/custom/bin');
    expect(dirs).toContain(path.join(home, '.local/bin'));
    expect(dirs).toContain(path.join(home, '.cargo/bin'));
    expect(dirs.filter(value => value === '/usr/bin')).toHaveLength(1);
    if (process.platform === 'darwin') expect(dirs).toContain('/opt/homebrew/bin');
  });
  it('probe_bin_checks_executable_files_directly', async () => {
    const host = await createTestHost();
    try {
      const file = path.join(host.app.dataDir, 'demo-tool');
      await writeFile(file, '#!/bin/sh\nexit 0\n');
      await chmod(file, 0o700);
      expect(await probeBinInDirs('demo-tool', [host.app.dataDir])).toBe(true);
      await chmod(file, 0o600);
      expect(await probeBinInDirs('demo-tool', [host.app.dataDir])).toBe(false);
    } finally { await host.dispose(); }
  });
  it('partition_rejects_invalid_bin_names', () => {
    const [valid, invalid] = partitionRequires({
      bins: ['python', 'bad bin', '$(whoami)'], env: ['GOOD_ENV', 'bad-env'],
      python_packages: ['pymupdf', 'bad pkg', '../evil'],
    });
    expect(valid).toEqual({ bins: ['python'], env: ['GOOD_ENV'], python_packages: ['pymupdf'] });
    expect(invalid).toHaveLength(5);
  });
  it('probe_env_reports_presence_only', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    const previous = process.env.SKILL_REQUIRES_TEST_VAR;
    process.env.SKILL_REQUIRES_TEST_VAR = '1';
    try {
      const probe = await host.invoke<import('../api.ts').SkillRequiresProbe>('skill_probe_requires', {
        env: ['SKILL_REQUIRES_TEST_VAR', 'SKILL_REQUIRES_MISSING_VAR'],
      });
      expect(probe.env.find(value => value.name === 'SKILL_REQUIRES_TEST_VAR')?.set).toBe(true);
      expect(probe.env.find(value => value.name === 'SKILL_REQUIRES_MISSING_VAR')?.set).toBe(false);
      expect(probe.missing_count).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.SKILL_REQUIRES_TEST_VAR;
      else process.env.SKILL_REQUIRES_TEST_VAR = previous;
      await host.dispose();
    }
  });
  it('probe_python_packages_reports_missing_and_stdlib_found', async () => {
    const host = await createTestHost({ plugins: [pathsPlugin, plugin], provide: { settings: memorySettings(), storage: unavailableStorage() } });
    try {
      const probe = await host.invoke<import('../api.ts').SkillRequiresProbe>('skill_probe_requires', {
        pythonPackages: ['json', 'deep-student-definitely-missing-pkg-xyz'],
      });
      expect(probe.python_packages.find(value => value.name === 'deep-student-definitely-missing-pkg-xyz')?.found).toBe(false);
      const pythonPresent = await probeBin('python3') || await probeBin('python');
      expect(probe.python_packages.find(value => value.name === 'json')?.found).toBe(pythonPresent);
      expect(probe.missing_count).toBe(pythonPresent ? 1 : 2);
    } finally { await host.dispose(); }
  });
  it('format_hints_for_missing_python_on_windows', () => {
    const hints = formatMissingRequiresHints({ bins: [{ name: 'python', found: false }], env: [], python_packages: [], invalid: [], missing_count: 1 });
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain('python');
    if (process.platform === 'win32') expect(hints[0]).toContain('winget install Python.Python.3');
  });
  it('format_hints_for_missing_python_packages', () => {
    const hints = formatMissingRequiresHints({ bins: [], env: [], python_packages: [{ name: 'pymupdf', found: false }], invalid: [], missing_count: 1 });
    expect(hints).toHaveLength(1);
    for (const text of ['pymupdf', 'fitz', 'uv pip install pymupdf', 'python3 -m pip install pymupdf', 'local_shell_execute']) expect(hints[0]).toContain(text);
  });
});
