#!/usr/bin/env node
/**
 * Public Repository Surface & Layout Gate (`npm run check:public-surface`)
 *
 * Enforces the strict minimal-public-surface and lean-layout policy for `helixnow/deep-student`:
 *   1. Root directory allowlist: ONLY 12 visible architectural modules + `.github`.
 *   2. Root file allowlist: zero debug HTMLs, trace configs, or secondary tool clutter.
 *   3. `docs/` and `scripts/` subdirectory allowlists: prevents script/doc sprawl.
 *   4. Zero internal process/migration artifacts (`LANE.md`, `BLOCKERS.md`, `TESTMAP.md`,
 *      `ACCEPTANCE.md`, `*-PROGRESS.md`, `WP-*`, `DRAFT-*.md`, `*.log`).
 *   5. Zero tracked files matching `.gitignore` & zero internal environment fingerprints.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const ALLOWED_ROOT_DIRS = new Set([
  '.github',
  'contracts',
  'docs',
  'electron',
  'examples',
  'host',
  'mobile',
  'public',
  'resources',
  'scripts',
  'src',
  'tests',
  'web',
]);

const ALLOWED_ROOT_FILES = new Set([
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.release-channel',
  '.release-please-manifest.json',
  '.stylelintignore',
  '.stylelintrc.json',
  'ACKNOWLEDGMENTS.md',
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'README_CN.md',
  'demo-app.html',
  'demo.html',
  'eslint.config.js',
  'hero.html',
  'index.html',
  'package-lock.json',
  'package.json',
  'postcss.config.js',
  'release-please-config.json',
  'tailwind.config.js',
  'tsconfig.host.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.plugins.json',
  'vite.config.ts',
  'vite.demo.config.ts',
  'vitest.config.ts',
  'vitest.host.config.ts',
  'vitest.setup.ts',
]);

const ALLOWED_SCRIPTS_ENTRIES = new Set([
  'generate-version.mjs',
  '__tests__',
  'arch',
  'ci',
  'contracts',
  'licenses',
  'lint',
  'plugins',
  'portability',
]);

const ALLOWED_DOCS_FILES = new Set([
  'docs/README.md',
  'docs/BUILD-CONFIG.md',
  'docs/CODE_STYLE.md',
  'docs/DEEPSEEK-API.md',
  'docs/README-BUILD.md',
  'docs/THIRD_PARTY_LICENSES.md',
  'docs/WEBUI-AND-PWA.md',
]);

const ALLOWED_DOCS_PREFIXES = [
  'docs/assets/readme/',
  'docs/community/',
  'docs/frontend/',
  'docs/plugins/',
  'docs/user-guide/',
];

const FORBIDDEN_BASENAMES = new Set([
  'AGENTS.md',
  'CLAUDE.md',
  'LANE.md',
  'BLOCKERS.md',
  'TESTMAP.md',
  'ACCEPTANCE.md',
  'HANDOFF.md',
  'PENDING.md',
  'NEEDS.md',
  'MIGRATION-REPORT.md',
  'MIGRATION-STATE.md',
  'OWNER-SEAMS.md',
  'native-needs.md',
  'todo.md',
  'TODO.md',
]);

const FORBIDDEN_BASENAME_RE = /^(?:(?:W|S)\d+-PROGRESS\.md|WP-\d+.*|DRAFT-.*\.md|.*\.log)$/;
const FINGERPRINT_SCAN_EXT = /\.(?:md|mjs|cjs|js|ts|tsx|yml|yaml|json|sh|toml)$/i;
const FORBIDDEN_FINGERPRINTS = [
  { label: 'internal host alias (ser-38)', re: /\bser-38\b/ },
  { label: 'internal server user path (/home/dsdev)', re: /\/home\/dsdev\b/ },
  { label: 'local macOS developer home path (/Users/heli)', re: /\/Users\/heli\b/ },
  { label: 'internal orchestrator path (oc-orchestrator)', re: /\boc-orchestrator\b/ },
];

function gitLines(args) {
  const out = execFileSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\n').filter(Boolean);
}

const errors = [];
const tracked = gitLines(['ls-files']);

for (const file of tracked) {
  const parts = file.split('/');
  const top = parts[0];
  const base = parts[parts.length - 1];

  if (parts.length === 1) {
    if (!ALLOWED_ROOT_FILES.has(top)) {
      errors.push(`[root-file] "${file}" is not in ALLOWED_ROOT_FILES`);
    }
  } else if (!ALLOWED_ROOT_DIRS.has(top)) {
    errors.push(`[root-dir] "${top}/" (from "${file}") is not an allowed top-level directory`);
  }

  if (top === 'scripts' && parts.length >= 2 && !ALLOWED_SCRIPTS_ENTRIES.has(parts[1])) {
    errors.push(`[scripts-layout] "scripts/${parts[1]}" is outside the consolidated scripts directory layout`);
  }

  if (top === 'docs') {
    const ok = ALLOWED_DOCS_FILES.has(file) || ALLOWED_DOCS_PREFIXES.some((p) => file.startsWith(p));
    if (!ok) {
      errors.push(`[docs-whitelist] "${file}" is outside allowed public docs directories`);
    }
  }

  if (FORBIDDEN_BASENAMES.has(base) || FORBIDDEN_BASENAME_RE.test(base)) {
    errors.push(`[internal-artifact] "${file}" matches forbidden internal/migration artifact pattern`);
  }

  if (
    file !== 'scripts/ci/check-public-surface.mjs' &&
    file !== 'CHANGELOG.md' &&
    FINGERPRINT_SCAN_EXT.test(file)
  ) {
    const abs = path.join(ROOT, file);
    if (fs.existsSync(abs) && fs.statSync(abs).size <= 2 * 1024 * 1024) {
      const content = fs.readFileSync(abs, 'utf8');
      for (const fp of FORBIDDEN_FINGERPRINTS) {
        if (fp.re.test(content)) {
          errors.push(`[fingerprint] "${file}" contains ${fp.label}`);
        }
      }
    }
  }
}

const ignoredButTracked = gitLines(['ls-files', '-i', '-c', '--exclude-standard']);
for (const file of ignoredButTracked) {
  errors.push(`[gitignore-drift] "${file}" is tracked in git despite matching .gitignore`);
}

if (errors.length > 0) {
  console.error(`Public surface check FAILED (${errors.length} violation(s)):`);
  for (const err of errors.slice(0, 50)) {
    console.error(`  - ${err}`);
  }
  if (errors.length > 50) {
    console.error(`  ... and ${errors.length - 50} more`);
  }
  process.exit(1);
}

console.log(`check-public-surface OK (${tracked.length} tracked files verified)`);
