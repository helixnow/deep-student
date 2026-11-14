// lane → 允许改动的路径（oc-dispatch 与质量反馈共用的唯一来源）。
// 业务 lane 取派发提示表格"目录（只写这里）"一行；F lane 在此列出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DISPATCH = path.join(ROOT, 'docs/dev/electron-migration/dispatch');

export const F_PATHS = {
  'F1-kernel': ['host/kernel/', 'host/profiles/'],
  'F2-shell': ['electron/'],
  'F3-storage': ['host/platform/storage/'],
  'F4-security': ['host/platform/secrets/', 'host/platform/settings/', 'host/platform/log/', 'host/platform/paths/',
    'host/platform/errors/', 'host/platform/diagnostics/', 'host/platform/time/', 'host/platform/util/', 'host/platform/net-policy/',
    'host/platform/API.md', 'host/platform/TESTMAP.md'],
  'F5-contracts': ['scripts/electron-migration/contracts/', 'contracts/ipc/', 'contracts/CHANGES.md', 'scripts/plugin-catalog/', 'docs/plugins/', 'examples/plugins/community-web-search/'],
  'F7-native': ['host/platform/native/', 'host/platform/vector/'],
};


// 复核 lane（R）：只写被验收方的 ACCEPTANCE.md（精确路径，最长前缀使其归验收人所有）与自己的复核报告。
// 新任务 lane（X）：独立目录 + 审计报告。
export const EXTRA_PATHS = {
  // 前端插件化 F1（规格 docs/plugins/FRONTEND-F1.md）。contracts/<area>.ts 精确路径使其归对应 lane，其余 src/ui-kernel/ 归 U1。
  'U1-ui-boot': ['src/main.tsx', 'src/demo/main.tsx', 'src/demo/app/main.tsx', 'src/ui-kernel/', 'src/ui-sdk/', 'src/ui-plugins/official/install.ts', 'src/ui-plugins/testing/', 'docs/dev/electron-migration/audits/U1-ui-boot.md'],
  'U2-ui-shell': ['src/components/layout/__tests__/MobileSidebarNavigation.dedup.test.tsx', 'tests/vitest/modernSidebarNavigation.test.tsx', 'src/app/shell/__tests__/desktopSidebarShell.source.test.ts', 'src/app/shell/__tests__/shellExitReachability.source.test.ts', 'src/App.tsx', 'src/components/ModernSidebar.tsx', 'src/components/layout/MobileSidebarNavigation.tsx', 'src/app/hooks/useDesktopSidebarElements.tsx', 'src/ui-kernel/contracts/shell.ts', 'src/ui-plugins/official/shell/', 'docs/dev/electron-migration/audits/U2-ui-shell.md'],
  'U3-ui-settings': ['src/features/settings/components/SettingsShellSidebar.tsx', 'src/features/settings/components/Settings.tsx', 'src/ui-kernel/contracts/settings.ts', 'src/ui-plugins/official/settings/', 'docs/dev/electron-migration/audits/U3-ui-settings.md'],
  'U4-ui-content': ['src/features/chat/components/renderers/CodeBlock.tsx', 'src/features/chat/components/__tests__/messageSearchContext.test.tsx', 'src/features/chat/components/renderers/__tests__/FlowToken.lazyCode.test.tsx', 'src/features/chat/components/renderers/__tests__/MarkdownRenderer.bold.test.tsx', 'src/features/chat/components/renderers/__tests__/MarkdownRenderer.codeblock.test.tsx', 'src/features/chat/components/renderers/__tests__/MarkdownRenderer.flowtoken.test.tsx', 'src/features/chat/components/renderers/__tests__/MarkdownRenderer.identity.test.tsx', 'src/features/chat/components/renderers/__tests__/StreamingBlockRenderer.visibility.test.tsx', 'src/features/chat/components/renderers/__tests__/blockRenderSkip.test.tsx', 'src/features/chat/components/renderers/__tests__/streamingCompletion.test.tsx', 'src/features/chat/components/renderers/__tests__/streamingDefaults.test.tsx', 'src/features/chat/components/renderers/MarkdownRenderer.tsx', 'src/features/learning-hub/components/LearningHubContextMenu.tsx', 'src/ui-kernel/contracts/content.ts', 'src/ui-plugins/official/content/', 'docs/dev/electron-migration/audits/U4-ui-content.md'],
  'R6-review-frontend': ['src/ui-plugins/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R6-review-frontend.md'],
  // 协调者（C）：只写自己的协调日志与审批文件；不写任何实现。
  'C1-app': ['docs/dev/electron-migration/coordination/C1-app.md', 'migration/approvals.d/C1-app.json'],
  'C2-platform': ['docs/dev/electron-migration/coordination/C2-platform.md', 'migration/approvals.d/C2-platform.json'],
  // 总指挥只写自己的指挥日志；不写实现、不写别人的看板。
  'C0-chief': ['docs/dev/electron-migration/coordination/C0-chief.md'],
  // 独立架构代理（S0）：只改编排脚本与文档，修复管线自身的自愈能力；不碰业务插件。
  'S0-architect': ['scripts/electron-migration/', 'docs/dev/electron-migration/'],
  'R1-review-llm': ['host/plugins/llm-providers/ACCEPTANCE.md', 'host/plugins/llm/ACCEPTANCE.md', 'host/plugins/agent-skills/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R1-review-llm.md'],
  'R2-review-agent': ['host/plugins/agent-workspace/ACCEPTANCE.md', 'host/plugins/agent-orchestration/ACCEPTANCE.md', 'host/plugins/chat-pipeline/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R2-review-agent.md'],
  'R3-review-vfs': ['host/plugins/vfs-repos/ACCEPTANCE.md', 'host/plugins/vfs-index/ACCEPTANCE.md', 'host/plugins/vfs-handlers/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R3-review-vfs.md'],
  'R4-review-sync': ['host/plugins/sync-providers/ACCEPTANCE.md', 'host/plugins/sync-support/ACCEPTANCE.md', 'host/plugins/backup/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R4-review-sync.md'],
  'R5-review-learning': ['host/plugins/qbank/ACCEPTANCE.md', 'host/plugins/review/ACCEPTANCE.md', 'host/plugins/anki/ACCEPTANCE.md', 'host/plugins/chatanki/ACCEPTANCE.md', 'docs/dev/electron-migration/audits/R5-review-learning.md'],
  'X1-e2e-smoke': ['host/e2e/smoke/', 'docs/dev/electron-migration/audits/X1-e2e-smoke.md'],
  'X2-frontend-contracts': ['scripts/electron-migration/frontend-audit/', 'docs/dev/electron-migration/audits/X2-frontend-contracts.md'],
  'X3-data-compat': ['host/e2e/data-compat/', 'docs/dev/electron-migration/audits/X3-data-compat.md'],
  'X6-gate-checks': ['scripts/electron-migration/lib/ledger-core.mjs', 'scripts/electron-migration/lib/ledger-core.d.mts', 'scripts/electron-migration/ledger.mjs', 'scripts/electron-migration/ledger.test.ts', 'scripts/electron-migration/gate-checks/', 'docs/dev/electron-migration/audits/X6-gate-checks.md'],
  'X7-differential': ['fixtures/', 'scripts/electron-migration/record/', 'host/e2e/differential/', 'src-tauri/crates/dstu-differential/', 'docs/dev/electron-migration/audits/X7-differential.md'],
  'X4-wiring-audit': ['scripts/electron-migration/wiring-audit/', 'docs/dev/electron-migration/audits/X4-wiring-audit.md'],
  'X5-stream-parity': ['host/e2e/streaming/', 'docs/dev/electron-migration/audits/X5-stream-parity.md'],
  // G3 语料写入 lane（2026-11-06）：只为各域的 equivalence/ 目录写场景 JSON，不写实现。
  // 与域 owner 共享同一目录，但文件按命令子集切分、互不重叠；owner lane 的迁移工作不受影响。
  'W-L13a': ['host/plugins/vfs/equivalence/'],
  'W-L13b': ['host/plugins/vfs-handlers/equivalence/'],
  'W-L04': ['host/plugins/chat/equivalence/'],
  'W-L14': ['host/plugins/qbank/equivalence/'],
  'W-L15': ['host/plugins/review/equivalence/'],
  'W-L18': ['host/plugins/media/equivalence/'],
  'W-L10': ['host/plugins/notes/equivalence/'],
  'W-L19': ['host/plugins/mcp/equivalence/', 'host/plugins/browser/equivalence/'],
  'W-L16': ['host/plugins/anki/equivalence/'],
};

// 临时授权（C1 裁定、C2 知会）：在 lane 的常规路径之外追加精确文件；对应改动进 main 后按决策编号删除该行。
// 精确路径会让该文件在授权期间归被授权 lane（laneOfFile 取最长匹配），原 owner 期间不要改它。
export const TEMP_GRANTS = {
  'U4-ui-content': [
    // D-154：模板 CSP（原归 L16 / 无归属）
    'host/plugins/anki/data/builtin-templates.json', 'src-tauri/src/data/builtin-templates.json', 'src/data/anki/builtin-templates.json',
    'src/components/previews/htmlSandboxPolicy.ts',
    // D-166：剥脚本行为变更随附测试
    'src/components/previews/__tests__/htmlSandboxPolicy.test.ts', 'tests/vitest/previews/htmlSandboxPreview.test.tsx',
    'tests/vitest/templates/templateRenderSanitization.test.tsx',
  ],
  // D-176：WP-168 改了 chat/api.ts 供方签名，L03 组合根占位契约须同提交适配（文件仍归 L03，WP-259 事后复核）
  'L04-chat-session': ['host/plugins/chat-pipeline/src/tool-runtime.ts'],
};

// 第二阶段 lane 处置（RESUME-PLAN.md §1）：dispatch/DISPOSITION.json 存在时生效，缺省即 v3 原状。
//   lanes: { <lane>: { action: retire|merge|continue, into?: <接手 lane>, reason } }——retire/merge 的 lane 不再是活动 lane，
//          它的路径归 into；paths: { <lane>: { replace?: [...], add?: [...] } }——调整或新增（P*、U5 等）lane 的路径。
export const DISPOSITION_FILE = path.join(DISPATCH, 'DISPOSITION.json');

export function loadDisposition(file = DISPOSITION_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return JSON.parse(text);
}

let cached;
const current = () => (cached === undefined ? (cached = loadDisposition()) : cached);

/** { active, action, into, reason }：处置表里 retire/merge 的 lane 不活动；未列出的 lane 维持原状。 */
export function laneStatus(lane, disposition = current()) {
  const d = disposition?.lanes?.[lane];
  if (!d) return { active: true, action: null };
  return { active: d.action === 'continue', action: d.action, into: d.into ?? null, reason: d.reason ?? '' };
}

export function allowedPaths(lane, disposition = current()) {
  if (!laneStatus(lane, disposition).active) return [];
  const inherited = Object.entries(disposition?.lanes ?? {}).filter(([, d]) => d.action !== 'continue' && d.into === lane).flatMap(([l]) => basePaths(l, disposition));
  return [...basePaths(lane, disposition), ...inherited, ...(TEMP_GRANTS[lane] ?? [])];
}

function basePaths(lane, disposition) {
  const adj = disposition?.paths?.[lane];
  return [...(adj?.replace ?? v3Paths(lane)), ...(adj?.add ?? [])];
}

function v3Paths(lane) {
  if (EXTRA_PATHS[lane]) return [...EXTRA_PATHS[lane]];
  if (F_PATHS[lane]) return [...F_PATHS[lane], `migration/testmap/${lane}.md`, `migration/spec/${lane}.md`];
  const file = path.join(DISPATCH, `${lane}.md`);
  if (!fs.existsSync(file)) return [];
  const row = /\| 目录（只写这里） \| (.+) \|/.exec(fs.readFileSync(file, 'utf8'));
  if (!row) return [];
  return [...row[1].matchAll(/`(host\/plugins\/[^`]+)`/g)].map((m) => (m[1].endsWith('/') ? m[1] : `${m[1]}/`));
}

/** 活动 lane：有派发提示的 v3 lane（处置表生效后去掉 retire/merge 的，加上 P* 第二阶段 lane）。 */
export function allLanes(disposition = current()) {
  const re = disposition ? /^(F\d|L\d\d[a-z]?|R\d|X\d|C\d|U\d|P\d)-.*\.md$/ : /^(F\d|L\d\d[a-z]?|R\d|X\d|C\d|U\d)-.*\.md$/;
  return fs.readdirSync(DISPATCH).filter((f) => re.test(f)).map((f) => f.replace(/\.md$/, '')).filter((l) => laneStatus(l, disposition).active).sort();
}

/** 文件归属的 lane：取匹配路径前缀最长者。 */
export function laneOfFile(rel, lanes = allLanes(), disposition = current()) {
  let best = null;
  let bestLen = -1;
  for (const l of lanes) {
    for (const p of allowedPaths(l, disposition)) {
      const hit = p.endsWith('/') ? rel.startsWith(p) : rel === p;
      if (hit && p.length > bestLen) {
        best = l;
        bestLen = p.length;
      }
    }
  }
  return best;
}
