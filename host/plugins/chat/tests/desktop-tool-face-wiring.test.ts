/** #28: which frontend skill tools reach the model under the official desktop profile.
 * The frontend sends every loaded skill's embedded tool schemas; chat-pipeline withholds names without an
 * executable executor (RF-W02-executable-only-tool-face). This runs the same `advertises` check the tool loop
 * uses, over every tool the builtin skills declare, against the real plugin tree.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { CapabilityAcl } from '../../../kernel/acl.ts';
import { loadStartupProfile, OFFICIAL_PROFILE_PATH } from '../../../kernel/profile.ts';
import { PluginAdmin } from '../../../kernel/plugin-admin.ts';
import { UserProfileStore } from '../../../kernel/profile-store.ts';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import type { ToolRuntimeAuthorityOwner, ToolRuntimeTodoOwner } from '../../chat-pipeline/api.ts';

const SKILL_DIRS = ['src/features/chat/skills/builtin-tools', 'src/features/chat/skills/builtin'];
/**
 * Still withheld until W22's chatanki_run/chatanki_start executors (assault/W22-chatanki-executors) are integrated;
 * empty this set then and assert strictly that nothing is withheld.
 */
const PENDING = new Set(['builtin-chatanki_run', 'builtin-chatanki_start']);
const unreachable = (): never => { throw new Error('authority/todo owners are outside the advertisement check'); };
const authority: ToolRuntimeAuthorityOwner = { getSessionAuthorityState: unreachable, createPendingPlan: unreachable,
  setSessionPlanState: unreachable, consumeSessionPlanBinding: unreachable };
const todo: ToolRuntimeTodoOwner = { getTodoList: unreachable, persistTodoList: unreachable };

function skillToolNames(): string[] {
  const names = new Set<string>();
  for (const dir of SKILL_DIRS) {
    for (const file of readdirSync(dir).filter(name => name.endsWith('.ts'))) {
      for (const match of readFileSync(join(dir, file), 'utf8').matchAll(/name: '(builtin-[a-z0-9_]+)'/g)) names.add(match[1]!);
    }
  }
  return [...names].sort();
}

let root = '';
let host: TestHost;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dstu-tool-face-profile-'));
  vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  vi.stubEnv('XDG_CACHE_HOME', join(root, 'cache'));
  vi.stubEnv('DEEP_STUDENT_KEY_SEED_FILE_ONLY', '1');
  host = await createTestHost({ app: { dataDir: join(root, 'app'), platform: 'linux' }, acl: CapabilityAcl.fromDirectory('linux') });
  new PluginAdmin({ runtime: host.runtime, official: OFFICIAL_PROFILE_PATH,
    store: new UserProfileStore(join(host.app.dataDir, 'plugins/user.profile.json'), OFFICIAL_PROFILE_PATH) }).register();
  const loaded = await loadStartupProfile(host.runtime, { official: OFFICIAL_PROFILE_PATH });
  expect(loaded.degraded).toEqual([]);
}, 120_000);
afterAll(async () => {
  await host?.dispose();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

it('every builtin skill tool is offered to the model except the pending chatanki run/start', () => {
  const names = skillToolNames();
  expect(names.length).toBeGreaterThan(300);
  expect([...PENDING].filter(name => !names.includes(name))).toEqual([]);
  const advertisement = host.ctx.chatPipeline.bindToolRuntime(authority, todo).advertisement!;
  expect(names.filter(name => !advertisement.advertises(name) && !PENDING.has(name))).toEqual([]);
});

it('the tools the W12 smoke reported withheld besides run/start are offered (#27, #28)', () => {
  const advertisement = host.ctx.chatPipeline.bindToolRuntime(authority, todo).advertisement!;
  const fixed = ['builtin-unified_search', 'builtin-web_search', 'builtin-chatanki_control', 'builtin-chatanki_sync',
    'builtin-chatanki_wait', 'builtin-chatanki_update_library_card',
    'builtin-chatanki_delete_library_card', 'builtin-chatanki_enqueue_library_review', 'builtin-chatanki_set_library_suspended',
    'builtin-chatanki_undo_library_last_review'];
  expect(fixed.filter(name => !advertisement.advertises(name))).toEqual([]);
});
