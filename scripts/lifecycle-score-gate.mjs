#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync, spawnSync } from 'node:child_process';

const failures = [];

const ensure = (condition, message) => {
  if (!condition) failures.push(message);
};

const read = (path) => readFileSync(path, 'utf-8');

// grep-based search that works on all CI runners (no rg dependency)
const grepSearch = (pattern, dirs, excludeGlobs = []) => {
  const grepArgs = ['-rnE', pattern];
  for (const glob of excludeGlobs) {
    if (glob.startsWith('!')) {
      const g = glob.slice(1);
      if (g.includes('/')) grepArgs.push(`--exclude-dir=${g.replace(/\*\*\//g, '').replace(/\*/g, '*')}`);
      else grepArgs.push(`--exclude=${g}`);
    }
  }
  grepArgs.push(...(Array.isArray(dirs) ? dirs : [dirs]));
  const result = spawnSync('grep', grepArgs, { encoding: 'utf-8' });
  if (result.status === 0) return result.stdout.trim();
  return '';
};

// Gate 1: canonical navigation contract exists.
ensure(existsSync('src/app/navigation/canonicalView.ts'), 'missing canonical view contract');

// Gate 2: no deprecated command routes.
if (existsSync('src/command-palette/modules/navigation.commands.ts')) {
  const nav = read('src/command-palette/modules/navigation.commands.ts');
  ensure(!nav.includes('nav.goto.notes'), 'deprecated nav.goto.notes still exists');
  ensure(!nav.includes('nav.goto.review'), 'deprecated nav.goto.review still exists');
}

// Gate 3: onboarding selectors do not include removed entry.
if (existsSync('src/onboarding/definitions/mainFlow.ts')) {
  const onboarding = read('src/onboarding/definitions/mainFlow.ts');
  ensure(!onboarding.includes('nav-library'), 'onboarding still references nav-library');
}

// Gate 4: readiness gate exists.
ensure(existsSync('src/chat-v2/readiness/readinessGate.ts'), 'missing chat readiness gate');

// Gate 5: persistent migration banner exists.
ensure(
  existsSync('src/components/system-status/MigrationStatusBanner.tsx'),
  'missing migration status banner'
);

// Gate 6: docs consistency check must pass.
try {
  execSync('bash scripts/doc-consistency-check.sh', { stdio: 'pipe' });
} catch {
  failures.push('doc consistency check failed');
}

// Gate 7: legacy backup command strings must not reappear.
const legacyCommandChecks = [
  {
    pattern: "invoke\\([^\\n]*['\"]auto_backup['\"]",
    message: 'legacy auto_backup invoke detected',
  },
  {
    pattern: "invoke\\([^\\n]*['\"]export_backup_archive_with_options['\"]",
    message: 'legacy export_backup_archive_with_options invoke detected',
  },
  {
    pattern: "invoke\\([^\\n]*['\"]export_backup_archive['\"]",
    message: 'legacy export_backup_archive invoke detected',
  },
  {
    pattern: "invoke\\([^\\n]*['\"]import_backup_archive_with_options['\"]",
    message: 'legacy import_backup_archive_with_options invoke detected',
  },
  {
    pattern: "invoke\\([^\\n]*['\"]import_backup_archive['\"]",
    message: 'legacy import_backup_archive invoke detected',
  },
  {
    pattern:
      'pub\\s+async\\s+fn\\s+(auto_backup|export_backup_archive(_with_options)?|import_backup_archive(_with_options)?|prepare_for_backup_restore|cancel_backup_restore_preparation)\\b',
    message: 'legacy backup tauri command function still exists',
  },
  {
    pattern:
      'crate::backup::(auto_backup|export_backup_archive(_with_options)?|import_backup_archive(_with_options)?|prepare_for_backup_restore|cancel_backup_restore_preparation)',
    message: 'legacy backup command still registered in lib.rs',
  },
];

for (const check of legacyCommandChecks) {
  const out = grepSearch(check.pattern, ['src', 'src-tauri/src']);
  ensure(!out, check.message);
}

// Gate 8: deprecated views must not be directly exposed in UI command visibility/types.
if (existsSync('src/command-palette/modules/chat.commands.ts')) {
  const chatCommands = read('src/command-palette/modules/chat.commands.ts');
  ensure(
    !/visibleInViews\s*:\s*\[[^\]]*'(analysis|review|notes|chat)'/.test(chatCommands),
    'chat command palette still exposes deprecated views'
  );
}

if (existsSync('src/components/layout/Topbar.tsx')) {
  const topbar = read('src/components/layout/Topbar.tsx');
  ensure(
    !/\|\s*'(analysis|review|notes|chat|markdown-editor|textbook-library|exam-sheet|batch)'/.test(topbar),
    'Topbar CurrentView union still contains deprecated views'
  );
}

// Gate 8b: no direct deprecated view routing in production code.
const deprecatedViewRouteOut = grepSearch(
  "\\bview\\s*:\\s*['\"](analysis|review|notes|chat|markdown-editor|textbook-library|exam-sheet|batch)['\"]",
  'src',
);
ensure(!deprecatedViewRouteOut, 'deprecated view direct routing still exists in src');


// Gate 9: cross-module events must use centralized event registry hook.
ensure(existsSync('src/hooks/useEventRegistry.ts'), 'missing centralized useEventRegistry hook');

if (existsSync('src/App.tsx')) {
  const appCode = read('src/App.tsx');
  ensure(!appCode.includes("addEventListener('NAVIGATE_TO_VIEW'"), 'App.tsx still uses raw addEventListener for NAVIGATE_TO_VIEW');
}

if (existsSync('src/chat-v2/pages/ChatV2Page.tsx')) {
  const chatPage = read('src/chat-v2/pages/ChatV2Page.tsx');
  ensure(!chatPage.includes("addEventListener('CHAT_OPEN_ATTACHMENT_PREVIEW'"), 'ChatV2Page still uses raw listener for attachment preview');
  ensure(!chatPage.includes("document.addEventListener('context-ref:preview'"), 'ChatV2Page still uses raw listener for context-ref:preview');
}


// Gate 10: production source must not use alert/confirm fallback flows.
// TODO: Replace remaining window.confirm() calls with proper dialog components
const alertConfirmOut = grepSearch(
  "\\b(alert|confirm|window\\.confirm)\\s*\\(",
  'src',
  ['!*.test.*', '!*.example.*', '!*.examples.*', '!__tests__'],
);
if (alertConfirmOut) {
  console.warn('[lifecycle-score-gate] WARN: production source still uses alert/confirm (non-blocking)');
  console.warn(alertConfirmOut);
}

// Gate 11: main entry points must not import deprecated SimpleTooltip directly.
if (existsSync('src/App.tsx')) {
  const appCode = read('src/App.tsx');
  ensure(!appCode.includes("@/components/ui/SimpleTooltip"), 'App.tsx still imports SimpleTooltip');
}

if (existsSync('src/components/layout/Topbar.tsx')) {
  const topbarCode = read('src/components/layout/Topbar.tsx');
  ensure(!topbarCode.includes("@/components/ui/SimpleTooltip"), 'Topbar.tsx still imports SimpleTooltip');
}

if (failures.length > 0) {
  console.error('[lifecycle-score-gate] FAILED');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('[lifecycle-score-gate] PASS');
