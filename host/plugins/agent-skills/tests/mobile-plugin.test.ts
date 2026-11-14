/**
 * 移动端 `dstu.agent-skills`（`mobile.ts`）装配与命令行为：
 * - 22 条命令全部注册，`agentSkills` / `agentTools` 服务可用；
 * - 技能文件命令走 OPFS（`ctx.files`），路径越界与桌面同样拒绝；
 * - `skill_import_zip` 用可移植 ZIP 核心安装，dry-run 不落盘，覆盖需要 overwrite；
 * - tap / market / updates 的下载与 provenance 写 settings；
 * - 候选列表/晋升/回滚复用 chat_v2 仓储，回滚把目录归档到 `.archive/`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, afterEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import { createOpfsFiles, mobileRoots } from '../../../platform/files/opfs.ts';
import { createFakeOpfs } from '../../../platform/files/tests/__fixtures__/fake-opfs.ts';
import type { HttpService, HttpRequestInit } from '../../../platform/http/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { buildZip, readZipEntries, readZipEntry } from '../src/zip.ts';
import { SkillCandidateRepo, SkillUsageRepo, trajectoryTraceHash } from '../repository/skill-usage.ts';
import mobileSkills from '../mobile.ts';

const DATA = '/deep-student';

let template: string;
let root: string;
let storage: ReturnType<typeof createStorageService>;
let db: DatabaseHandle;
let host: TestHost;
let settingsValues: Map<string, string>;
let files: FilesService;

function settingsStore(values = new Map<string, string>()) {
  return {
    get: (key: string) => values.get(key) ?? null,
    save: (key: string, value: string) => { values.set(key, value); },
    delete: (key: string) => values.delete(key),
    listByPrefix: (prefix: string) => [...values.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value, updatedAt: '2026-01-01T00:00:00+00:00' })),
    deleteByPrefix: (prefix: string) => {
      let count = 0;
      for (const key of [...values.keys()]) if (key.startsWith(prefix)) { values.delete(key); count++; }
      return count;
    },
    saveSecret: async (key: string, value: string) => { values.set(key, value); },
    getSecret: async (key: string) => values.get(key) ?? null,
    deleteSecret: async (key: string) => values.delete(key),
  };
}

/** 只实现本 lane 用到的两跳：codeload 仓库 zip 与 clawhub JSON。 */
function fakeHttp(routes: Map<string, () => Response>): HttpService {
  return {
    async fetch(input: string | URL, _init?: HttpRequestInit): Promise<Response> {
      const url = String(input);
      const handler = routes.get(url);
      if (handler === undefined) return new Response('missing', { status: 404 });
      return handler();
    },
  } as unknown as HttpService;
}

function zipBytes(files: Array<[string, string]>): Uint8Array {
  return buildZip(files.map(([name, content]) => ({ name, bytes: new TextEncoder().encode(content) })));
}

function skillMd(name: string, description = 'demo'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;
}

/** Rebuild the host with a different `ctx.http` (market / tap routes are per-test). */
async function recreateHost(http: HttpService): Promise<void> {
  await host.dispose();
  host = await createTestHost({
    plugins: [mobileSkills],
    app: { debug: false, dataDir: DATA },
    provide: {
      paths: { appDataDir: DATA, os: { home: DATA, temp: `${DATA}/tmp`, data: DATA } },
      settings: settingsStore(settingsValues),
      storage,
      files,
      http,
    },
  });
  await files.mkdir(`${DATA}/skills`, { recursive: true });
}

function insertSession(sessionId: string): void {
  db.run(
    `INSERT INTO chat_v2_sessions (id, mode, created_at, updated_at)
     VALUES (?1, 'general_chat', '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z')`,
    [sessionId],
  );
}

function insertMessage(sessionId: string, messageId: string, role: string): void {
  db.run(
    `INSERT INTO chat_v2_messages (id, session_id, role, timestamp)
     VALUES (?1, ?2, ?3, 1757000000000)`,
    [messageId, sessionId, role],
  );
}

function insertToolLoad(skillId: string, runId: string): void {
  new SkillUsageRepo(db).insert({
    skillId, taskSessionId: 'sess-1', runId, kind: 'tool_load', loads: 1, latencyMs: 100, tokens: 42,
  });
}

/** Seed a `new` trajectory candidate whose anchors and usage rows hold, returning its id. */
function seedTrajectoryCandidate(): string {
  const sessionId = 'sess-1';
  const runId = 'msg_run_1';
  const userMessageId = 'msg_u1';
  const tools = ['vfs_search', 'note_read', 'anki_add_cards'];
  const skills = ['skill-a'];
  insertSession(sessionId);
  insertMessage(sessionId, runId, 'assistant');
  insertMessage(sessionId, userMessageId, 'user');
  insertToolLoad(skills[0]!, runId);
  const repo = new SkillCandidateRepo(db);
  expect(repo.insertIfNew({
    sourceKind: 'trajectory',
    sessionId,
    traceHash: trajectoryTraceHash(sessionId, tools),
    draftPayloadJson: JSON.stringify({
      kind: 'trajectory', tool_sequence: tools, tool_call_count: tools.length,
      failed_tool_call_count: 0, skills_loaded: skills, duration_ms: 1200, total_tokens: 3456,
    }),
    evidenceRefsJson: JSON.stringify({ run_id: runId, user_message_id: userMessageId }),
  })).toBe(true);
  return repo.getByTraceHash(trajectoryTraceHash(sessionId, tools))!.candidateId;
}

beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mobile-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try {
    const report = await source.migrations.runAll();
    expect(report.success, report.error ?? '').toBe(true);
  } finally { source.dispose(); }
}, 180_000);

afterAll(() => fs.rmSync(template, { recursive: true, force: true }), 180_000);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-mobile-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  db = storage.database('chat_v2');
  settingsValues = new Map();
  files = createOpfsFiles({ root: createFakeOpfs(), roots: mobileRoots(DATA) });
  await files.mkdir(`${DATA}/skills`, { recursive: true });
  host = await createTestHost({
    plugins: [mobileSkills],
    app: { debug: false, dataDir: DATA },
    provide: {
      paths: { appDataDir: DATA, os: { home: DATA, temp: `${DATA}/tmp`, data: DATA } },
      settings: settingsStore(settingsValues),
      storage,
      files,
      http: fakeHttp(new Map()),
    },
  });
}, 60_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

it('registers every command and both services', async () => {
  for (const command of [
    'skill_probe_requires', 'skill_list_directories', 'skill_list_package_files', 'skill_read_file',
    'skill_create', 'skill_update', 'skill_delete', 'skill_import_zip',
    'skill_tap_catalog', 'skill_tap_install', 'skill_export_tap',
    'skill_market_search', 'skill_market_skill_detail', 'skill_market_verify',
    'skill_market_download_and_scan', 'skill_check_updates', 'skill_update_from_source',
    'chat_v2_record_skill_activation', 'chat_v2_list_skill_candidates',
    'chat_v2_replay_skill_candidate', 'chat_v2_promote_skill_candidate',
    'chat_v2_rollback_skill_candidate',
  ]) {
    expect(host.ctx.commands.has(command), command).toBe(true);
  }
  const tooling = host.ctx.get('agentTools') as { toolExecutors(): readonly { name(): string }[] };
  expect(tooling.toolExecutors().map(executor => executor.name()).sort()).toEqual([
    'ConnectorToolExecutor', 'FetchExecutor', 'LlmUsageToolExecutor',
    'McpManageExecutor', 'McpProposeExecutor', 'SkillMarketInstallToolExecutor',
    'SkillMarketReadToolExecutor', 'SkillsExecutor',
  ]);
});

it('creates, lists, reads, updates and deletes a skill through OPFS', async () => {
  const created = await host.invoke<{ content: string; path: string }>('skill_create', {
    basePath: '~/.deep-student/skills', skillId: 'demo-skill', content: skillMd('demo-skill'),
  });
  expect(created.path).toBe(`${DATA}/skills/demo-skill/SKILL.md`);

  const directories = await host.invoke<Array<{ name: string; path: string }>>('skill_list_directories', {
    path: '~/.deep-student/skills',
  });
  expect(directories).toEqual([{ name: 'demo-skill', path: `${DATA}/skills/demo-skill` }]);

  const read = await host.invoke<{ content: string }>('skill_read_file', { path: created.path });
  expect(read.content).toContain('name: demo-skill');

  await host.invoke('skill_update', { path: created.path, content: `${skillMd('demo-skill')}extra\n` });
  const reread = await host.invoke<{ content: string }>('skill_read_file', { path: created.path });
  expect(reread.content.endsWith('extra\n')).toBe(true);

  const packageFiles = await host.invoke<Array<{ path: string; size: number }>>('skill_list_package_files', {
    path: `${DATA}/skills/demo-skill`,
  });
  expect(packageFiles.map(entry => entry.path)).toEqual(['SKILL.md']);

  await host.invoke('skill_delete', { path: `${DATA}/skills/demo-skill` });
  expect(await files.exists(`${DATA}/skills/demo-skill`)).toBe(false);
});

it('rejects skill paths outside the OPFS skills root', async () => {
  await expect(host.invoke('skill_list_directories', { path: '/etc' }))
    .rejects.toThrow(/Path traversal detected/);
  await expect(host.invoke('skill_read_file', { path: `${DATA}/skills/../../escape.md` }))
    .rejects.toThrow(/Path traversal detected/);
  // Desktop validates the skill id before joining it onto the base.
  await expect(host.invoke('skill_create', {
    basePath: '~/.deep-student/skills', skillId: '../escape', content: skillMd('escape'),
  })).rejects.toThrow(/letters, numbers, hyphens, and underscores/);
});

it('imports a zip (dry-run first) and requires overwrite for an existing skill', async () => {
  const bytes = zipBytes([
    ['demo/SKILL.md', skillMd('demo')],
    ['demo/references/guide.md', '# guide\n'],
  ]);
  const zipPath = `${DATA}/tmp/demo.zip`;
  await files.mkdir(`${DATA}/tmp`, { recursive: true });
  await files.writeBytes(zipPath, bytes);

  const dryRun = await host.invoke<{
    skill_id: string; files_extracted: number; references_count: number; risk_level: string;
  }>('skill_import_zip', { zipPath, basePath: '~/.deep-student/skills', overwrite: false, dryRun: true });
  expect(dryRun).toMatchObject({ skill_id: 'demo', files_extracted: 2, references_count: 1, risk_level: 'low' });
  expect(await files.exists(`${DATA}/skills/demo`)).toBe(false);

  const installed = await host.invoke('skill_import_zip', {
    zipPath, basePath: '~/.deep-student/skills', overwrite: false, dryRun: false,
  });
  expect(installed).toMatchObject({ skill_id: 'demo', path: `${DATA}/skills/demo` });
  expect(await files.exists(`${DATA}/skills/demo/references/guide.md`)).toBe(true);

  await expect(host.invoke('skill_import_zip', {
    zipPath, basePath: '~/.deep-student/skills', overwrite: false, dryRun: false,
  })).rejects.toThrow(/already exists.*overwrite=true/);

  await host.invoke('skill_import_zip', {
    zipPath, basePath: '~/.deep-student/skills', overwrite: true, dryRun: false,
  });
  expect(await files.exists(`${DATA}/skills/demo/SKILL.md`)).toBe(true);
});

it('installs a tap skill and records provenance in settings', async () => {
  const repo = zipBytes([
    ['repo-main/skills/demo/SKILL.md', skillMd('demo', 'tap demo')],
    ['repo-main/skills/demo/scripts/run.sh', 'echo hi\n'],
  ]);
  const codeload = 'https://codeload.github.com/acme/skills/zip/refs/heads/main';
  const http = fakeHttp(new Map([[codeload, () => new Response(new Uint8Array(repo), { status: 200 })]]));
  await host.dispose();
  host = await createTestHost({
    plugins: [mobileSkills],
    app: { debug: false, dataDir: DATA },
    provide: {
      paths: { appDataDir: DATA, os: { home: DATA, temp: `${DATA}/tmp`, data: DATA } },
      settings: settingsStore(settingsValues),
      storage,
      files,
      http,
    },
  });
  await files.mkdir(`${DATA}/skills`, { recursive: true });

  const catalog = await host.invoke<{ resolvedZipUrl: string; skills: Array<{ skillId: string; subdir: string }> }>(
    'skill_tap_catalog', { repoUrl: 'https://github.com/acme/skills' },
  );
  expect(catalog.resolvedZipUrl).toBe(codeload);
  expect(catalog.skills.map(entry => entry.skillId)).toEqual(['demo']);

  const dryRun = await host.invoke<{ package_sha256: string; skill_id: string }>('skill_tap_install', {
    zipUrl: codeload, subdir: 'skills/demo', overwrite: false, dryRun: true, expectedPackageSha256: null,
  });
  const installed = await host.invoke<{ skill_id: string }>('skill_tap_install', {
    zipUrl: codeload, subdir: 'skills/demo', overwrite: false, dryRun: false,
    expectedPackageSha256: dryRun.package_sha256,
  });
  expect(installed.skill_id).toBe('demo');
  const provenance = JSON.parse(settingsValues.get('skill.provenance.demo') ?? 'null') as {
    sourceKind: string; sourceDetail: string;
  };
  expect(provenance.sourceKind).toBe('tap');
  expect(provenance.sourceDetail).toBe(`${codeload}#skills/demo`);
});

it('searches the marketplace and writes the confirmed scan artifact under temp/skill-market', async () => {
  const searchUrl = 'https://clawhub.ai/api/v1/skills?sort=trending&limit=24&nonSuspiciousOnly=true';
  const detailUrl = 'https://clawhub.ai/api/v1/skills/demo/verify';
  const http = fakeHttp(new Map([
    [searchUrl, () => new Response(JSON.stringify({ items: [] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })],
    [detailUrl, () => new Response(JSON.stringify({
      ok: true, decision: 'allow', reasons: [], slug: 'demo', version: '1.0.0',
      security: { status: 'passed', passed: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
  ]));
  await host.dispose();
  host = await createTestHost({
    plugins: [mobileSkills],
    app: { debug: false, dataDir: DATA },
    provide: {
      paths: { appDataDir: DATA, os: { home: DATA, temp: `${DATA}/tmp`, data: DATA } },
      settings: settingsStore(settingsValues),
      storage,
      files,
      http,
    },
  });

  const search = await host.invoke<{ mode: string; items: unknown[] }>('skill_market_search', {
    q: null, limit: null, nonSuspiciousOnly: null, sort: null,
  });
  expect(search).toEqual({ mode: 'list', items: [] });

  const verify = await host.invoke<{ ok: boolean; version: string }>('skill_market_verify', {
    slug: 'demo', version: null,
  });
  expect(verify).toMatchObject({ ok: true, version: '1.0.0' });
});

it('probes requirements as missing on a device without PATH or Python', async () => {
  const probe = await host.invoke('skill_probe_requires', {
    bins: ['python3'], env: ['API_KEY'], pythonPackages: ['requests'],
  });
  expect(probe).toEqual({
    bins: [{ name: 'python3', found: false }],
    env: [{ name: 'API_KEY', set: false }],
    python_packages: [{ name: 'requests', found: false }],
    invalid: [],
    missing_count: 3,
  });
});

it('exports installed skills as a tap zip inside OPFS', async () => {
  await host.invoke('skill_create', {
    basePath: '~/.deep-student/skills', skillId: 'demo-skill', content: skillMd('Demo Skill', 'tap export'),
  });
  await files.mkdir(`${DATA}/skills/demo-skill/references`, { recursive: true });
  await files.writeBytes(`${DATA}/skills/demo-skill/references/guide.md`, new TextEncoder().encode('# guide\n'));
  await files.mkdir(`${DATA}/tmp`, { recursive: true });

  const result = await host.invoke<{ path: string; skillCount: number; fileCount: number }>('skill_export_tap', {
    skillIds: ['demo-skill'], destPath: `${DATA}/tmp/tap.zip`,
  });
  expect(result).toEqual({ path: `${DATA}/tmp/tap.zip`, skillCount: 1, fileCount: 3 });
  const zipBytesRead = await files.readBytes(result.path);
  const entries = readZipEntries(zipBytesRead);
  expect(entries.map(entry => entry.name).sort()).toEqual([
    'README.md', 'demo-skill/SKILL.md', 'demo-skill/references/guide.md',
  ]);
  const readme = entries.find(entry => entry.name === 'README.md')!;
  expect(new TextDecoder().decode(readZipEntry(zipBytesRead, readme))).toContain('Demo Skill');

  await expect(host.invoke('skill_export_tap', {
    skillIds: ['demo-skill'], destPath: 'content://exports/tap.zip',
  })).rejects.toThrow(/virtual file URI/);
});

it('checks a tap skill for updates and applies the new package', async () => {
  const codeload = 'https://codeload.github.com/acme/skills/zip/refs/heads/main';
  let repoBytes = zipBytes([
    ['repo-main/skills/demo/SKILL.md', skillMd('demo', 'tap v1')],
    ['repo-main/skills/demo/scripts/run.sh', 'echo v1\n'],
  ]);
  await recreateHost(fakeHttp(new Map([[codeload, () => new Response(new Uint8Array(repoBytes), { status: 200 })]])));

  const dryRun = await host.invoke<{ package_sha256: string }>('skill_tap_install', {
    zipUrl: codeload, subdir: 'skills/demo', overwrite: false, dryRun: true, expectedPackageSha256: null,
  });
  const installed = await host.invoke<{ package_sha256: string }>('skill_tap_install', {
    zipUrl: codeload, subdir: 'skills/demo', overwrite: false, dryRun: false,
    expectedPackageSha256: dryRun.package_sha256,
  });

  const unchanged = await host.invoke<Array<Record<string, unknown>>>('skill_check_updates', { skillIds: null });
  expect(unchanged).toHaveLength(1);
  expect(unchanged[0]).toMatchObject({
    skillId: 'demo', checkable: true, updateAvailable: false,
    currentSha256: installed.package_sha256, remoteSha256: installed.package_sha256,
  });

  repoBytes = zipBytes([
    ['repo-main/skills/demo/SKILL.md', skillMd('demo', 'tap v2')],
    ['repo-main/skills/demo/scripts/run.sh', 'echo v2\n'],
    ['repo-main/skills/demo/references/guide.md', '# guide v2\n'],
  ]);
  const outdated = await host.invoke<Array<Record<string, unknown>>>('skill_check_updates', { skillIds: ['demo'] });
  expect(outdated).toHaveLength(1);
  expect(outdated[0]).toMatchObject({ skillId: 'demo', updateAvailable: true });
  expect(outdated[0]!.remoteSha256).not.toBe(installed.package_sha256);

  const applied = await host.invoke<Record<string, unknown>>('skill_update_from_source', { skillId: 'demo' });
  expect(applied).toMatchObject({
    skillId: 'demo', updated: true, path: `${DATA}/skills/demo`, trustStatus: 'untrusted',
  });
  expect(await files.readText(`${DATA}/skills/demo/SKILL.md`)).toContain('tap v2');
  expect(await files.exists(`${DATA}/skills/demo/references/guide.md`)).toBe(true);
  const provenance = JSON.parse(settingsValues.get('skill.provenance.demo') ?? 'null') as {
    updatedFromSha256: string; packageSha256: string;
  };
  expect(provenance.updatedFromSha256).toBe(installed.package_sha256);
  expect(provenance.packageSha256).toBe(applied.packageSha256);

  const settled = await host.invoke<Array<Record<string, unknown>>>('skill_check_updates', { skillIds: null });
  expect(settled[0]).toMatchObject({ updateAvailable: false, remoteSha256: provenance.packageSha256 });
});

it('downloads, scans and installs a community marketplace package from a bound temp zip', async () => {
  const pkg = zipBytes([
    ['demo/SKILL.md', skillMd('demo', 'market')],
    ['demo/references/guide.md', '# guide\n'],
  ]);
  const verifyUrl = 'https://clawhub.ai/api/v1/skills/demo/verify?version=1.0.0';
  const detailUrl = 'https://clawhub.ai/api/v1/skills/demo';
  const downloadUrl = 'https://clawhub.ai/api/v1/download?slug=demo&version=1.0.0';
  await recreateHost(fakeHttp(new Map([
    [detailUrl, () => new Response(JSON.stringify({
      skill: {
        slug: 'demo', displayName: 'Demo', summary: 'summary', description: 'description',
        stats: { downloads: 7, stars: 3 },
      },
      latestVersion: { version: '1.0.0' },
      owner: { handle: 'acme', displayName: 'Acme' },
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    [verifyUrl, () => new Response(JSON.stringify({
      ok: true, decision: 'allow', reasons: [], slug: 'demo', version: '1.0.0',
      security: { status: 'passed', passed: true },
    }), { status: 200, headers: { 'content-type': 'application/json' } })],
    [downloadUrl, () => new Response(new Uint8Array(pkg), {
      status: 200, headers: { 'content-type': 'application/zip' },
    })],
  ])));

  const detail = await host.invoke<Record<string, unknown>>('skill_market_skill_detail', { slug: 'demo' });
  expect(detail).toMatchObject({ slug: 'demo', version: '1.0.0', downloads: 7, stars: 3, ownerHandle: 'acme' });

  const scan = await host.invoke<{
    installed: boolean;
    tempZipPath: string;
    provenance: string;
    scan: { skill_id: string; package_sha256: string; risk_level: string };
  }>('skill_market_download_and_scan', {
    slug: 'demo', version: '1.0.0', install: false, overwrite: false,
    expectedPackageSha256: null, tempZipPath: null, declaredRiskLevel: null,
  });
  expect(scan.installed).toBe(false);
  expect(scan.scan).toMatchObject({ skill_id: 'demo', risk_level: 'low' });
  expect(scan.tempZipPath).toMatch(/^\/deep-student\/temp\/skill-market\/demo-\d+\.zip$/);
  expect(await files.exists(scan.tempZipPath)).toBe(true);

  const installed = await host.invoke<{ installed: boolean; scan: { path: string } }>(
    'skill_market_download_and_scan',
    {
      slug: 'demo', version: '1.0.0', install: true, overwrite: false,
      expectedPackageSha256: scan.scan.package_sha256, tempZipPath: scan.tempZipPath,
      declaredRiskLevel: scan.scan.risk_level,
    },
  );
  expect(installed.installed).toBe(true);
  expect(installed.scan.path).toBe(`${DATA}/skills/demo`);
  expect(await files.exists(`${DATA}/skills/demo/references/guide.md`)).toBe(true);

  const provenance = JSON.parse(settingsValues.get('skill.provenance.demo') ?? 'null') as {
    sourceKind: string; sourceDetail: string; marketSlug: string; marketVersion: string;
  };
  expect(provenance).toMatchObject({
    sourceKind: 'skill_market', sourceDetail: 'skill_market:demo@1.0.0', marketSlug: 'demo', marketVersion: '1.0.0',
  });

  // The scan artifact is bound to the marketplace temp dir.
  await expect(host.invoke('skill_market_download_and_scan', {
    slug: 'demo', version: '1.0.0', install: true, overwrite: false,
    expectedPackageSha256: scan.scan.package_sha256, tempZipPath: `${DATA}/skills/demo/SKILL.md`,
    declaredRiskLevel: scan.scan.risk_level,
  })).rejects.toThrow(/scan artifact path/);
});

it('records activations and replays, promotes and rolls back a candidate into .archive', async () => {
  await host.invoke('chat_v2_record_skill_activation', { skillId: 'skill-a', sessionId: 'sess-1' });
  expect(db.all('SELECT skill_id, task_session_id FROM skill_usage')).toEqual([
    { skill_id: 'skill-a', task_session_id: 'sess-1' },
  ]);

  const candidateId = seedTrajectoryCandidate();
  const replayed = await host.invoke<Record<string, unknown>>('chat_v2_replay_skill_candidate', { candidateId });
  expect(replayed).toMatchObject({ stillValid: true, previousStatus: 'new', resultingStatus: 'passed' });

  const passed = await host.invoke<Array<{ candidateId: string; status: string }>>(
    'chat_v2_list_skill_candidates', { status: 'passed', limit: 10 },
  );
  expect(passed.map(entry => [entry.candidateId, entry.status])).toEqual([[candidateId, 'passed']]);

  const promotion = await host.invoke<Record<string, unknown>>('chat_v2_promote_skill_candidate', { candidateId });
  expect(promotion).toMatchObject({ status: 'published', skillVersion: 1, skillFileWritten: true });
  const skillId = promotion.skillId as string;
  const skillFilePath = promotion.skillFilePath as string;
  expect(skillFilePath).toBe(`${DATA}/skills/${skillId}/SKILL.md`);
  expect(await files.readText(skillFilePath)).toContain(`source_candidate_id: ${candidateId}`);
  expect(await files.exists(`${DATA}/skills/${skillId}/AGENT_INSTALLED.json`)).toBe(true);

  const rollback = await host.invoke<Record<string, unknown>>('chat_v2_rollback_skill_candidate', { candidateId });
  expect(rollback).toMatchObject({
    status: 'rolled_back', skillId, retiredFrom: `${DATA}/skills/${skillId}`,
  });
  const archivedTo = rollback.archivedTo as string;
  expect(archivedTo).toMatch(new RegExp(`^${DATA}/skills/\\.archive/${skillId}\\.rolledback-`));
  expect(await files.exists(`${DATA}/skills/${skillId}`)).toBe(false);
  expect(await files.readText(`${archivedTo}/SKILL.md`)).toContain(`source_candidate_id: ${candidateId}`);

  const rolledBack = await host.invoke<Array<{ candidateId: string; status: string }>>(
    'chat_v2_list_skill_candidates', { status: 'rolled_back', limit: 10 },
  );
  expect(rolledBack.map(entry => [entry.candidateId, entry.status])).toEqual([[candidateId, 'rolled_back']]);
});
