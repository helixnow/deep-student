// 前端内置技能声明的每个工具，都要有官方桌面 profile 装配后经 `agentTools` 注册、能 canHandle 它的执行器。
// 现存缺口登记在 agent-tool-coverage-baseline.json；只拦截新增缺口，已补上的基线项只提示清理。
// 按现状重写基线（保留已有 reason）：DSTU_WRITE_TOOL_COVERAGE_BASELINE=1 跑本测试。
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../kernel/profile.ts';
import { PluginAdmin } from '../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../kernel/testing.ts';
import type { AgentToolExecutor } from '../../plugins/agent-skills/api.ts';

vi.mock('@/utils/platform', () => ({ getPlatform: () => 'macos' }));

const BASELINE = new URL('./agent-tool-coverage-baseline.json', import.meta.url);

const DEFAULT_REASON = '2026-11-07 快照：desktop profile 未注册可处理该工具的执行器（W02/W03/W04 正在补齐）';

interface BaselineEntry { tool: string; skill: string; reason?: string }

interface FrontendSkill { id: string; embeddedTools?: { name: string }[] }

/** 前端模块按 URL 动态导入，避免 tsconfig.host.json 把 src/ 拉进 host 类型检查。 */
async function frontendModule<T>(rel: string): Promise<T> {
  return await import(new URL(`../../../src/features/chat/skills/${rel}`, import.meta.url).href) as T;
}

async function frontendTools(): Promise<{ tool: string; skill: string }[]> {
  const { builtinToolSkills } = await frontendModule<{ builtinToolSkills: FrontendSkill[] }>('builtin-tools/index.ts');
  const { builtinSkills } = await frontendModule<{ builtinSkills: FrontendSkill[] }>('builtin/index.ts');
  const tools = new Map<string, string>();
  for (const skill of [...builtinToolSkills, ...builtinSkills]) {
    for (const tool of skill.embeddedTools ?? []) if (!tools.has(tool.name)) tools.set(tool.name, skill.id);
  }
  return [...tools].map(([tool, skill]) => ({ tool, skill })).sort((a, b) => a.tool.localeCompare(b.tool));
}

describe('agent tool executor coverage (official desktop profile)', () => {
  let root = '';
  let host: TestHost | undefined;
  let executors: readonly AgentToolExecutor[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dstu-tool-coverage-'));
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
    vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
    vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
    host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
    new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
      store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
    const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
    expect(loaded.degraded).toEqual([]);
    executors = host.ctx.agentTools.toolExecutors();
  }, 120_000);

  afterAll(async () => {
    await host?.dispose();
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('every builtin skill tool has a registered executor, except baselined gaps', async () => {
    expect(executors.length).toBeGreaterThan(0);
    const tools = await frontendTools();
    expect(tools.length).toBeGreaterThan(100);
    const uncovered = tools.filter(({ tool }) => !executors.some((e) => e.canHandle(tool)));
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { entries: BaselineEntry[] };
    const known = new Set(baseline.entries.map((e) => e.tool));
    const fresh = uncovered.filter(({ tool }) => !known.has(tool));
    const stale = baseline.entries.filter((e) => !uncovered.some(({ tool }) => tool === e.tool));

    const bySkill = new Map<string, string[]>();
    for (const { tool, skill } of uncovered) bySkill.set(skill, [...(bySkill.get(skill) ?? []), tool]);
    console.info(`agent-tool-coverage: ${tools.length} frontend tools, ${executors.length} executors (${executors.map((e) => e.name()).join(', ')}); ${uncovered.length} uncovered`);
    for (const [skill, names] of [...bySkill].sort((a, b) => b[1].length - a[1].length)) console.info(`  ${skill}: ${names.length} — ${names.join(', ')}`);
    if (process.env.DSTU_WRITE_TOOL_COVERAGE_BASELINE === '1') {
      const reasons = new Map(baseline.entries.map((e) => [e.tool, e.reason]));
      const entries = uncovered.map(({ tool, skill }) => ({ tool, skill, reason: reasons.get(tool) ?? DEFAULT_REASON }));
      writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, entries }, null, 1)}\n`);
      return;
    }
    if (stale.length) console.warn(`agent-tool-coverage: ${stale.length} baseline entries are now covered; remove them: ${stale.map((e) => e.tool).join(', ')}`);

    expect(fresh, 'new builtin tools without an executor (register one via agentTools or baseline with a reason)').toEqual([]);
  });
});
