/**
 * F7 WASI 引擎在 app.asar 里能跑（真实 Electron utilityProcess）：打包版的 Host 从 asar 加载 `loader.ts`，
 * `runWasm` 由 Host 线程读 `.wasm` 后把编译好的模块交给 `worker.mjs`；`runWasmSync`（`mindmapXml.parse`）则是
 * 常驻的 `worker.mjs` 线程自己 `readFileSync` asar 内的 `.wasm`。两条路径都只在 asar 里才会暴露问题，
 * 打包冒烟里没有能不经 LLM 触发 `mindmapXml` 的入口，所以在这里用与打包相同的文件集合单独打一个 asar 验证。
 */
import { spawnElectron } from './electron-process.ts';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { builderFilter } from './builder-filter.ts';

const require = createRequire(import.meta.url);
const repoRoot = join(import.meta.dirname, '..', '..');
const config = require('../electron-builder.config.cjs') as { files: string[] };
const asar = require('@electron/asar') as { createPackage(src: string, dest: string): Promise<unknown> };

const OPML = '<opml version="2.0"><body><outline text="根"><outline text="子"/></outline></body></opml>';

const PROBE = `import { mindmapXml } from './host/platform/native/xml/index.ts';
import { removeRun, runWasm } from './host/platform/native/wasm/loader.ts';
const text = ${JSON.stringify(OPML)};
const result = { entry: import.meta.filename };
const failure = (error) => (error instanceof Error ? error.stack : String(error));
try { result.sync = mindmapXml.parse(text); } catch (error) { result.syncError = failure(error); }
try {
  const run = await runWasm({ engine: 'xml', op: 'parse', text });
  result.async = run.response;
  await removeRun(run);
} catch (error) { result.asyncError = failure(error); }
process.parentPort.postMessage(result);
process.exit(0);
`;

/** 打包时会进包的 `host/platform/native/{wasm,xml}` 文件（同一份 electron-builder files 规则）。 */
function shippedFiles(): string[] {
  const ships = builderFilter(config.files);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (ships(relative(repoRoot, file))) files.push(relative(repoRoot, file));
    }
  };
  for (const dir of ['wasm', 'xml']) walk(join(repoRoot, 'host', 'platform', 'native', dir));
  return files;
}

describe.skipIf(process.platform === 'win32')('F7 WASI engine runs from app.asar (real Electron utilityProcess)', () => {
  const tmp = mkdtempSync(join(realpathSync(tmpdir()), 'dstu-asar-wasm-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('runWasm and the synchronous worker (mindmapXml) both work with loader, worker.mjs and the .wasm inside the archive', async () => {
    const files = shippedFiles();
    for (const file of ['loader.ts', 'core.ts', 'worker.mjs', 'f7-native-wasm.wasm']) expect(files, file).toContain(`host/platform/native/wasm/${file}`);
    expect(files).toContain('host/platform/native/xml/index.ts');

    const stage = join(tmp, 'stage');
    for (const file of files) {
      mkdirSync(dirname(join(stage, file)), { recursive: true });
      copyFileSync(join(repoRoot, file), join(stage, file));
    }
    writeFileSync(join(stage, 'package.json'), '{ "name": "asar-wasm-probe", "type": "module" }\n');
    writeFileSync(join(stage, 'probe.mjs'), PROBE);
    const archive = join(tmp, 'app.asar');
    await asar.createPackage(stage, archive);
    rmSync(stage, { recursive: true, force: true });

    const child = await spawnElectron(require('electron') as string, [join(import.meta.dirname, 'fixtures', 'asar-utility-main.mjs')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ASAR_UTILITY_ENTRY: join(archive, 'probe.mjs') },
      stdio: 'pipe',
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += String(chunk)));
    child.stderr.on('data', (chunk) => (output += String(chunk)));
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    const line = output.split('\n').find((l) => l.startsWith('ASAR-UTILITY-RESULT '));
    expect(line, output).toBeDefined();
    const result = JSON.parse(line!.slice('ASAR-UTILITY-RESULT '.length)) as Record<string, unknown>;

    expect(result.entry).toBe(join(archive, 'probe.mjs'));
    expect(result.syncError).toBeUndefined();
    expect(result.sync).toMatchObject({
      kind: 'element', localName: 'opml',
      children: [{ localName: 'body', children: [{ localName: 'outline', attributes: [{ localName: 'text', namespace: null, value: '根' }], children: [{ localName: 'outline' }] }] }],
    });
    expect(result.asyncError).toBeUndefined();
    expect(result.async).toMatchObject({ ok: true });
    expect((result.async as { nodes: Array<{ localName: string }> }).nodes.map((n) => n.localName)).toEqual(['opml', 'body', 'outline', 'outline']);
    expect(code, output).toBe(0);
  }, 60_000);
});
