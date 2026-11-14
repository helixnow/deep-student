import { ZipArchive } from '../../platform/util/zip.ts';
import { expect } from '@playwright/test';
import { launchApp, osHomeOf } from './__tests__/support/app.ts';
import { passFirstRun, dismissWelcome, waitForBridge } from './__tests__/support/onboarding.ts';
import { openDockApp } from './__tests__/support/renderer.ts';
import { answerNextSaveDialog } from './__tests__/support/dialogs.ts';
import { startFakeLlm, type ScriptCall } from './__tests__/support/fake-llm.ts'; // boundary-allow test-double: e2e smoke script uses Playwright fake LLM test harness from __tests__/support
import { configureFakeModel } from './__tests__/support/llm-config.ts'; // boundary-allow test-double: e2e smoke script uses Playwright fake LLM test harness from __tests__/support
import { existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Run with Node 26, built renderer/preload and a new, isolated data directory.
// The deterministic model exercises real app tools; use a real model separately for autonomous selection.
const root = process.argv[2];
if (!root) throw new Error('Pass a newly created isolated test directory');
const json = (data: unknown) => JSON.stringify(data);

const report: Record<string, unknown> = { root, boot: [], error: null };
const checkpoint = (name: string, value: unknown) => {
  report[name] = value;
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(name, JSON.stringify(value).slice(0, 2000));
};
const logLines = () => {
  const rootLogs = join(osHomeOf(root), '.local', 'share', 'com.deepstudent.app', 'logs');
  if (!existsSync(rootLogs)) return [];
  return readdirSync(rootLogs, { recursive: true, encoding: 'utf8', withFileTypes: true })
    .filter(e => e.isFile() && /\.log(?:\.\d+)?$/.test(e.name))
    .map(e => ({ file: join(e.parentPath, e.name).slice(rootLogs.length + 1),
      hits: readFileSync(join(e.parentPath, e.name), 'utf8').split('\n').filter(l => /创建临时导出目录失败|ENOTDIR|notes_export|EEXIST/.test(l)) }));
};
const marker = 'DSTU_EXPORT_RECOVERY_PROBE';
const verifyArchive = (file: string) => {
  const zip = ZipArchive.from(readFileSync(file));
  const notes = zip.entries.filter(entry => entry.name.startsWith('notes/') && entry.name.endsWith('.md'));
  expect(notes).toHaveLength(1);
  expect(Buffer.from(zip.read(notes[0]!.name)).toString('utf8')).toContain(marker);
};
const basename = 'notes-verified.zip';
const target = join(root, basename);
const obstruction = join(root, 'data', 'exports');
const prompt = '刚才内置笔记导出失败了。请自己查应用的前后端错误，关联同一次导出，找到原因并恢复，然后验证导出成功。没有证据就说明卡在哪一步。';
const archive = async (a: Awaited<ReturnType<typeof launchApp>>) => {
  await openDockApp(a.page, 'notes');
  const focused = a.page.locator('[data-wb-window][data-focused="true"]');
  await focused.locator('[data-notes-explorer] header').getByRole('button', { name: /更多操作|More actions/, exact: true }).click({ timeout: 12_000 });
  await focused.getByRole('menuitem', { name: /导入或导出知识库|Import or export library/ }).click({ timeout: 10_000 });
  const exportBtn = focused.getByRole('button', { name: /^(导出|Export)$/ });
  await answerNextSaveDialog(a, target);
  await focused.getByRole('button', { name: /^(选择…|Choose…|Choose\.\.\.)$/ }).click({ timeout: 10_000 });
  await exportBtn.click({ timeout: 10_000 });
  return focused;
};
const captureNotifications = async (a: Awaited<ReturnType<typeof launchApp>>) => {
  await a.page.evaluate(() => {
    const w = globalThis as typeof globalThis & { __trialNotify?: unknown[] };
    w.__trialNotify = [];
    window.addEventListener('showGlobalNotification', event => w.__trialNotify!.push((event as CustomEvent).detail));
  });
};
const notifications = (a: Awaited<ReturnType<typeof launchApp>>) => a.page.evaluate(() =>
  (globalThis as typeof globalThis & { __trialNotify?: Array<{type: string; message: string}> }).__trialNotify ?? []);
const openApp = async () => {
  const a = await launchApp({ root, electronArgs: ['--disable-gpu'], env: process.env.DSTU_TEST_DEV_URL ? { DS_ELECTRON_DEV_URL: process.env.DSTU_TEST_DEV_URL } : {} });
  await waitForBridge(a.page);
  await a.call('plugin:host|status', {}, 90_000);
  return a;
};

let app: Awaited<ReturnType<typeof launchApp>> | undefined;
let llm: Awaited<ReturnType<typeof startFakeLlm>> | undefined; // boundary-allow test-double: e2e smoke script uses Playwright fake LLM test harness from __tests__/support
try {
  app = await openApp();
  checkpoint('started', { pid: app.app.process().pid, launchMs: Math.round(app.launchMs) });
  await passFirstRun(app.page);
  llm = await startFakeLlm(); // boundary-allow test-double: e2e smoke script uses Playwright fake LLM test harness from __tests__/support
  await configureFakeModel(app, llm.baseUrl); // boundary-allow test-double: e2e smoke script uses Playwright fake LLM test harness from __tests__/support
  const seeded = await app.call<{id:string}>('notes_create', { note: { title: '导出自愈隔离测试', content_md: marker, tags: [] } });
  checkpoint('seed', { id: seeded.id });
  writeFileSync(obstruction, 'Deliberate staging directory obstruction, isolated test.\n', { flag: 'wx' });
  await captureNotifications(app);
  await app.mark('failed-export');
  await archive(app);
  await expect.poll(async () => (await notifications(app!)).some(n => n.type === 'error' && /导出|export/i.test(n.message)), { timeout: 12_000 }).toBe(true);

  const rows = app.wire().filter(r => r.phase === 'failed-export');
  const out = rows.find(r => r.kind === 'host-out' && r.message?.cmd === 'notes_export');
  const id = out?.message?.id ?? out?.message?.invokeId;
  const paired = rows.filter(r => r.kind === 'host-in' && id !== undefined && (r.message?.id ?? r.message?.invokeId) === id);
  const logs = logLines();
  checkpoint('failure', { notification: (await notifications(app)).filter(n => n.type === 'error'), noZip: !existsSync(target),
    rendererInvoke: rows.find(r => r.kind === 'renderer-invoke' && r.message?.cmd === 'notes_export')?.message,
    hostInvoke: out?.message, hostResponse: paired.map(r => r.message),
    rendererErrors: rows.filter(r => r.kind === 'renderer-result' && r.message?.callbackId === rows.find(x => x.kind === 'renderer-invoke' && x.message?.cmd === 'notes_export')?.message?.error).map(r => r.message),
    frontendReports: rows.filter(r => r.kind === 'renderer-invoke' && r.message?.cmd === 'report_frontend_log').length,
    onDisk: logs });
  await app.page.keyboard.press('Escape');
  await openDockApp(app.page, 'chat');
  const chatInput = app.page.locator('[data-wb-window][data-focused="true"]').getByTestId('input-bar-v2-textarea');
  await expect(chatInput).toBeVisible({ timeout: 12_000 });
  const rounds: Array<{offered: string[]; tools: readonly ScriptCall[]}> = [];
  llm.script = (turn) => {
    rounds.push({ offered: turn.toolNames, tools: turn.calls });
    checkpoint('roundProgress', rounds.map(r => ({ names: r.offered.filter(n => /diagnostic|recover|skills/.test(n)), toolCount: r.tools.length })));
    if (!turn.called('load_skills')) return { toolCalls: [{ tool: 'load_skills', arguments: { skills: ['self-service-tools'] } }] };
    const queries = turn.calls.filter(c => c.name.endsWith('app_diagnostics_query'));
    if (queries.length === 0) return { toolCalls: [{ tool: 'app_diagnostics_query', arguments: { operation: 'notes_export' } }] };
    const result = queries[0]?.result as { records?: Array<{id:string;source:string;code?:string}> };
    const records = result?.records ?? ((result as any)?.result?.records ?? []);
    const incident = records.find(r => r.source === 'host' && r.code === 'NOTES_EXPORT_STAGE_UNAVAILABLE');
    if (!incident) { checkpoint('diagnosticMissing', result); return { text: 'DSTU_DIAG_PROBE_END' }; }
    if (queries.length === 1) return { toolCalls: [{ tool: 'app_diagnostics_query', arguments: { id: incident.id } }] };
    if (!turn.called('notes_export_recover')) return { toolCalls: [{ tool: 'notes_export_recover', arguments: { diagnosticId: incident.id } }] };
    return { text: 'DSTU_DIAG_PROBE_END' };
  };
  await app.mark('agent-recovery');
  await chatInput.fill(prompt);
  await app.page.getByTestId('btn-send').first().click({ timeout: 10_000 });
  await expect(app.page.getByText('DSTU_DIAG_PROBE_END', { exact: true })).toBeVisible({ timeout: 85_000 });
  const toolCalls = rounds.at(-1)?.tools ?? [];
  const summarize = toolCalls.filter((c: any) => !c.name.endsWith('load_skills'));
  checkpoint('agent', summarize);
  const results = summarize as Array<{ name: string; result: any; arguments: any }>;
  const details = results.filter(r => r.name.endsWith('app_diagnostics_query')).at(-1)?.result;
  const readback = details?.records ?? details?.result?.records ?? [];
  if (!readback.some((r: any) => r.source === 'frontend' && r.id === id) || !readback.some((r: any) => r.source === 'host' && r.id === id)) throw new Error('Correlation missing');
  const recoveredRaw = results.find(r => r.name.endsWith('notes_export_recover'))?.result;
  const recovered = recoveredRaw?.result ?? recoveredRaw;
  if (!recovered?.verified || recovered.noteCount !== 1 || !existsSync(obstruction)) throw new Error('Recovery did not verify or changed original staging: ' + json(recovered));
  const artifactDir = join(root, 'data', 'chat_v2_artifacts');
  const archivePath = readdirSync(artifactDir).map(session => join(artifactDir, session, recovered.artifact.path)).find(existsSync);
  if (!archivePath) throw new Error('Recovery artifact not found');
  verifyArchive(archivePath);
  const destination = join(root, 'diagnostics.zip');
  const diagnostics = await app.call('export_diagnostics_bundle', { options: { destination, includeDebugLogs: false } });
  const archiveZip = ZipArchive.from(readFileSync(destination));
  const auditFile = archiveZip.entries.find(entry => entry.name.endsWith('_diagnostic.log'));
  if (!auditFile) throw new Error('Exported diagnostics does not include incidents');
  const audit = archiveZip.read(auditFile).toString('utf8');
  expect(audit).not.toContain(root);
  for (const source of ['frontend', 'host']) {
    expect(audit.split('\n').some(line => line.includes(String(id)) && line.includes('"source":"' + source + '"'))).toBe(true);
  }
  checkpoint('externalDiagnostics', diagnostics);
  checkpoint('recovery', { appPid: app.app.process().pid, obstructionPreserved: existsSync(obstruction), recovered });
  await app.mark('ordinary-export-after-recovery');
  await archive(app);
  await expect.poll(() => existsSync(target), { timeout: 12_000 }).toBe(true);
  verifyArchive(target);
  checkpoint('ordinaryExport', { bytes: readFileSync(target).length, pid: app.app.process().pid });
  const previous = app.app.process().pid;
  await app.close();
  app = await openApp();
  await dismissWelcome(app.page);
  await app.mark('ordinary-export-after-relaunch');
  const reopenedTarget = join(root, 'notes-after-relaunch.zip');
  await openDockApp(app.page, 'notes');
  const focused = app.page.locator('[data-wb-window][data-focused="true"]');
  await focused.locator('[data-notes-explorer] header').getByRole('button', { name: /更多操作|More actions/, exact: true }).click();
  await focused.getByRole('menuitem', { name: /导入或导出知识库|Import or export library/ }).click();
  await answerNextSaveDialog(app, reopenedTarget);
  await focused.getByRole('button', { name: /^(选择…|Choose…|Choose\.\.\.)$/ }).click();
  await focused.getByRole('button', { name: /^(导出|Export)$/ }).click();
  await expect.poll(() => existsSync(reopenedTarget), { timeout: 12_000 }).toBe(true);
  verifyArchive(reopenedTarget);
  checkpoint('relaunch', { previous, current: app.app.process().pid, bytes: readFileSync(reopenedTarget).length, obstructionPreserved: existsSync(obstruction) });
} catch(e) {
  checkpoint('error', e instanceof Error ? e.stack : String(e));
  if (app) {
    checkpoint('view', (await app.page.locator('body').innerText().catch(() => '')).slice(0, 1400));
    checkpoint('lastWire', app.wire().slice(-12).map(r => ({ phase: r.phase, kind: r.kind, cmd: r.message?.cmd, messageKind: r.message?.kind })));
  }
  process.exitCode = 1;
} finally {
  await app?.close();
  await llm?.close();
}
