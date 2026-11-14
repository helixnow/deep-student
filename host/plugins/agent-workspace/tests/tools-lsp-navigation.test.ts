import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import type { JsonValue } from '../src/tools/shared.ts';
import {
  LspNavigationExecutor, LspSession, fileUri, languageForPath, locateServer, normalizeResultUris,
  serverCommand, sourcePosition,
} from '../src/tools/lsp-navigation.ts';
import { createWorkspaceHost } from './host-support.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'l05-lsp-')));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

it('language_mapping_covers_initial_server_set', () => {
  expect(languageForPath('lib.rs')).toBe('rust');
  expect(languageForPath('view.tsx')).toBe('typescript');
  expect(languageForPath('main.py')).toBe('python');
  expect(() => languageForPath('main.go')).toThrow();
});

it('source_positions_are_one_based_and_convert_to_utf16', () => {
  const position = sourcePosition('a😀b\n', 1, 3);
  expect(position).toEqual({ line: 0, character: 3 });
  expect(() => sourcePosition('a', 0, 1)).toThrow();
  expect(() => sourcePosition('a', 1, 3)).toThrow();
});

it('executor_contract_is_medium_readonly', () => {
  const executor = new LspNavigationExecutor();
  expect(executor.canHandle('builtin-workspace_lsp_definition')).toBe(true);
  expect(executor.canHandle('workspace_lsp_document_symbols')).toBe(true);
  expect(executor.canHandle('workspace_symbol_outline')).toBe(false);
  expect(executor.sensitivityLevel('workspace_lsp_hover')).toBe('medium');
  expect(executor.concurrencyClass('workspace_lsp_references')).toBe('serial');
});

it('result_uris_are_relative_and_external_locations_are_removed', () => {
  const temp = tmp();
  const root = path.join(temp, 'workspace');
  fs.mkdirSync(root);
  const inside = fileUri(path.join(root, 'src/lib.rs'), false);
  const outside = fileUri(path.join(temp, 'dependency/lib.rs'), false);
  const result: JsonValue = [
    { uri: inside, range: {} },
    { targetUri: outside, targetRange: {} },
  ];
  const normalized = normalizeResultUris(result, root);
  if (!Array.isArray(normalized)) throw new Error('normalized result must stay an array');
  expect(normalized.length).toBe(1);
  const first = normalized[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) {
    throw new Error('normalized entry must be an object');
  }
  expect(first['uri']).toBe('src/lib.rs');
});

it('rust_analyzer_completes_initialize_handshake_when_installed', async () => {
  let executable: string;
  try {
    executable = locateServer('rust');
  } catch {
    return;
  }
  const version = serverCommand(executable, ['--version']);
  const available = spawnSync(version.command, version.args, { stdio: 'ignore', timeout: 5_000 });
  // Rust also returns when rustup installed only a proxy, without the component.
  if (available.status !== 0) return;
  const root = tmp();
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "lsp-smoke"\nversion = "0.1.0"\nedition = "2021"\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/lib.rs'), 'pub fn answer() -> u32 { 42 }\n');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let session: LspSession | undefined;
  try {
    session = await Promise.race([
      LspSession.start({ root, language: 'rust', appVersion: '0.11.0', signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('rust-analyzer initialization timed out'));
        }, 20_000);
      }),
    ]);
    expect(session.isRunning()).toBe(true);
  } finally {
    clearTimeout(timer);
    if (session) await session.kill();
    else controller.abort();
  }
}, 30_000);

it('aborting ctx.signal cancels LSP cold start and in-flight requests immediately', async () => {
  const binDir = tmp();
  const root = tmp();
  const file = path.join(root, 'index.ts');
  fs.writeFileSync(file, 'export const answer = 42;\n');

  const serverScript = path.join(binDir, 'test-lsp-server.mjs');
  fs.writeFileSync(serverScript, [
    'const mode = process.env.TEST_LSP_MODE || "hang-init";',
    'let buf = Buffer.alloc(0);',
    'function send(obj) {',
    '  const body = Buffer.from(JSON.stringify(obj), "utf8");',
    '  process.stdout.write(`Content-Length: ${body.length}\\r\\n\\r\\n`);',
    '  process.stdout.write(body);',
    '}',
    'process.stdin.on("close", () => process.exit(0));',
    'process.stdin.on("end", () => process.exit(0));',
    'process.stdin.on("data", chunk => {',
    '  buf = Buffer.concat([buf, chunk]);',
    '  for (;;) {',
    '    const headerEnd = buf.indexOf("\\r\\n\\r\\n");',
    '    if (headerEnd < 0) break;',
    '    const header = buf.slice(0, headerEnd).toString("utf8");',
    '    const match = /Content-Length:\\s*(\\d+)/i.exec(header);',
    '    if (!match) break;',
    '    const len = Number(match[1]);',
    '    const total = headerEnd + 4 + len;',
    '    if (buf.length < total) break;',
    '    const msg = JSON.parse(buf.slice(headerEnd + 4, total).toString("utf8"));',
    '    buf = buf.slice(total);',
    '    if (msg.method === "initialize" && mode === "hang-request") {',
    '      send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });',
    '    }',
    '  }',
    '});',
  ].join('\n'));

  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'typescript-language-server.cmd'), `@echo off\r\n"${process.execPath}" "${serverScript}" %*\r\n`);
  } else {
    const sh = path.join(binDir, 'typescript-language-server');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`);
    fs.chmodSync(sh, 0o755);
  }

  const prevPath = process.env.PATH;
  const prevMode = process.env.TEST_LSP_MODE;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;
  const { host, storage } = await createWorkspaceHost();
  const wsRoot = path.join(host.app.dataDir, 'ws');
  fs.mkdirSync(wsRoot);
  fs.writeFileSync(path.join(wsRoot, 'index.ts'), 'export const answer = 42;\n');
  await host.invoke('chat_v2_set_workspace_root', { path: wsRoot });
  const executor = new LspNavigationExecutor(() => host.ctx.nativeWindowsFiles);
  const baseCtx = {
    sessionId: 'sess-lsp',
    dataDir: host.app.dataDir,
    settings: host.ctx.settings,
  };

  try {
    // 1. Cold-start cancellation
    process.env.TEST_LSP_MODE = 'hang-init';
    const initController = new AbortController();
    const initTimer = setTimeout(() => initController.abort(), 40);
    const initStart = Date.now();
    const initRes = await executor.execute(
      { id: 'c1', name: 'builtin-workspace_lsp_hover', arguments: { path: 'index.ts', line: 1, column: 1 } },
      { ...baseCtx, signal: initController.signal },
    );
    clearTimeout(initTimer);
    expect(initRes.success).toBe(false);
    expect(initRes.error).toContain('cancelled');
    expect(Date.now() - initStart).toBeLessThan(3_000);

    // 2. In-flight request cancellation after initialize completes
    process.env.TEST_LSP_MODE = 'hang-request';
    const reqController = new AbortController();
    const reqTimer = setTimeout(() => reqController.abort(), 80);
    const reqStart = Date.now();
    const reqRes = await executor.execute(
      { id: 'c2', name: 'builtin-workspace_lsp_hover', arguments: { path: 'index.ts', line: 1, column: 1 } },
      { ...baseCtx, signal: reqController.signal },
    );
    clearTimeout(reqTimer);
    expect(reqRes.success).toBe(false);
    expect(reqRes.error).toContain('cancelled');
    expect(Date.now() - reqStart).toBeLessThan(3_000);
  } finally {
    executor.dispose();
    await new Promise(resolve => { setTimeout(resolve, 100); });
    storage.dispose();
    await host.dispose();
    if (prevPath === undefined) delete process.env.PATH;
    else process.env.PATH = prevPath;
    if (prevMode === undefined) delete process.env.TEST_LSP_MODE;
    else process.env.TEST_LSP_MODE = prevMode;
  }
});
