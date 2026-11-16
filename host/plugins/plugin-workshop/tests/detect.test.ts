/**
 * The confirmation card tells what the built code itself uses (detect.ts), in plain words, next to the manifest's
 * lines. Information only: a candidate that uses files, programs or the network still builds and self-checks.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppInfo } from '../../../kernel/api.ts';
import { checkWorkshopLifecycle, compileWorkshop } from '../src/compiler.ts';
import { detectUse, detectedLines } from '../src/detect.ts';
import { declaredCapabilities } from '../src/declared.ts';
import { writeSourceFiles } from '../src/source.ts';
import { WorkshopStore } from '../src/store.ts';

const names = (name: string) => ({ notes: '笔记' } as Record<string, string>)[name] ?? name;

describe('detectUse', () => {
  it('reads Node built-ins, own network with literal hosts, timers and service methods from a Host bundle', () => {
    const host = [
      'import { readFile } from "node:fs/promises";', 'import { spawn } from "node:child_process";', 'import os from "os";',
      'import path from "node:path";', 'import left from "left-pad";',
      'export default { apply(ctx) {',
      '  setInterval(() => fetch("https://api.deepl.com/v2/translate", { method: "POST" }), 60000);',
      '  ctx.notes.repository.list(); ctx.notes.repository.create({}); ctx.notes?.repository?.getNote("x");',
      '  const svg = "<svg xmlns=\\"http://www.w3.org/2000/svg\\">";',
      '} };',
    ].join('\n');
    const use = detectUse({ host }, ['log', 'notes']);
    expect(use).toMatchObject({ nodeModules: ['child_process', 'fs/promises', 'os', 'path'], packages: ['left-pad'], network: true,
      hosts: ['api.deepl.com'], repeats: true, services: { notes: { reads: ['getNote', 'list'], writes: ['create'] } } });
    expect(detectedLines(use, names)).toEqual([
      '能读写你电脑上的文件', '能运行你电脑上的其他程序', '能读取电脑的系统信息（用户名、目录、硬件等）',
      '能访问 api.deepl.com', '能自己联网（不限于上面列出的网站）', '会在后台定时运行',
      '会修改「笔记」里的内容（create）', '会读取「笔记」（getNote、list）', '使用外部模块「left-pad」',
    ]);
  });

  it('says nothing for plain computation, tool.fetch, local helpers or the UI\'s shared modules', () => {
    const use = detectUse({
      host: 'import { join } from "node:path"; export const f = (tool) => tool.fetch("https://a.example.com"); const x = { fetch: 1 };',
      ui: 'import React from "react"; import { DsCard } from "@deepstudent/ui"; setTimeout(() => {}, 10);',
    });
    expect(detectedLines(use, names)).toEqual([]);
  });

  it('a UI half that fetches by itself is disclosed too', () => {
    const use = detectUse({ ui: 'export const load = () => window.fetch("https://api.example.org/x");' });
    expect(detectedLines(use, names)).toEqual(['能访问 api.example.org', '能自己联网（不限于上面列出的网站）']);
  });

  it('declaredCapabilities = manifest lines ∪ detected lines, without repeating well-known services', () => {
    const manifest = { id: 'workshop.plugin-x', permissions: ['service:pluginModel', 'service:notes'] };
    const use = detectUse({ host: 'import "node:fs"; ctx.pluginModel.complete({}); ctx.notes.repository.update(1);' }, ['pluginModel', 'notes']);
    expect(declaredCapabilities(manifest, ['pluginModel', 'notes'], use)).toEqual([
      '用当前对话模型生成文字', '使用应用服务「笔记」', '能读写你电脑上的文件', '会修改「笔记」里的内容（update）',
    ]);
    expect(declaredCapabilities(manifest, ['pluginModel', 'notes'])).toEqual(['用当前对话模型生成文字', '使用应用服务「笔记」']);
  });
});

describe('a learning-tool candidate that uses files, a program, the network and a timer', () => {
  it('still builds and self-checks; the card lists each use', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'dstu-detect-'));
    const store = new WorkshopStore(dataDir);
    const card = await store.propose({ sessionId: 'test', title: '同步', description: '说明', template: 'learning-tool', changes: [], capabilities: [] });
    const source = join(store.directory(card.id), 'source');
    const app = { version: '0.20.1', dataDir, debug: true } as AppInfo;
    await writeSourceFiles(source, [
      { path: 'package.json', content: JSON.stringify({ name: 'x', version: '1.0.0', type: 'module',
        engines: { deepStudent: '>=0.20.0 <1.0.0', deepStudentPluginApi: '1' },
        deepStudent: { manifestVersion: 1, id: card.pluginId, platforms: ['desktop'], host: './index.ts', ui: './ui.tsx' } }) },
      { path: 'index.ts', content: [
        "import { readFile } from 'node:fs/promises';",
        "import { execFile } from 'node:child_process';",
        'export default {',
        `  name: '${card.pluginId}',`,
        `  meta: { id: '${card.pluginId}', version: '1.0.0', ui: './ui.js' },`,
        "  inject: ['notes'],",
        '  apply(ctx: { notes: { repository: { list(): unknown; create(value: unknown): unknown } } }) {',
        '    const sync = async () => { const text = await readFile("/tmp/x.txt", "utf8"); await fetch("https://api.deepl.com/v2/translate", { method: "POST", body: text });',
        '      ctx.notes.repository.list(); ctx.notes.repository.create(text); execFile("git", ["status"]); };',
        '    void sync;',
        '    const timer = setInterval(() => undefined, 3_600_000); clearInterval(timer);',
        '  },',
        '};',
      ].join('\n') },
      { path: 'ui.tsx', content: "import { defineUiPlugin } from '@deepstudent/ui';\nexport default defineUiPlugin({ meta: { id: '" + card.pluginId + "', version: '1.0.0', host: true }, apply() {} });" },
    ]);
    const built = await compileWorkshop(source, join(store.directory(card.id), 'build'), card.pluginId, app);
    await checkWorkshopLifecycle(built, app, async () => ({ trust: 'full', safeMode: false, services: { notes: { repository: {} } } }));
    expect(built.check, built.check.errors.join('\n')).toMatchObject({ ok: true, compile: 'passed', lifecycle: 'passed' });
    expect(built.declared).toEqual([
      '使用应用服务「笔记」', '能读写你电脑上的文件', '能运行你电脑上的其他程序', '能访问 api.deepl.com', '能自己联网（不限于上面列出的网站）',
      '会在后台定时运行', '会修改「笔记」里的内容（create）', '会读取「笔记」（list）',
    ]);
  });
});
