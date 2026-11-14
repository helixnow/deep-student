import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('cold construction and a separate warm process return the exact two-field migration report', async () => {
  const isolated = fs.mkdtempSync(path.join(tmpdir(), 'memory-report-contract-'));
  const moduleUrl = new URL('./fixtures/migrated-schema.ts', import.meta.url).href;
  const run = async () => {
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import fs from 'node:fs';
       import path from 'node:path';
       const schema = await import(${JSON.stringify(moduleUrl)});
       const copy = await schema.createMigratedMemoryStorage('report-copy-');
       try {
         const template = await schema.prepareMemoryTestSchema();
         const cache = path.dirname(template.dir);
         const versions = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'].map(
           database => copy.storage.migrations.currentVersion(database));
         process.stdout.write(JSON.stringify({
           pid: process.pid, templateDir: template.dir, report: copy.report, versions,
           builderPid: Number(fs.readFileSync(path.join(cache, 'builder.pid'), 'utf8')),
           publishedReport: JSON.parse(fs.readFileSync(path.join(cache, 'ready.json'), 'utf8')),
         }));
       } finally {
         copy.storage.dispose();
         fs.rmSync(copy.dir, { recursive: true, force: true });
       }`], { env: { ...process.env, TMPDIR: isolated, TMP: isolated, TEMP: isolated } });
    return JSON.parse(stdout);
  };
  try {
    // A new OS temp root forces real runAll; no existing shared cache is removed.
    expect(fs.readdirSync(isolated)).toEqual([]);
    const cold = await run();
    const warm = await run();
    console.info('migration report cold/warm evidence', { cold, warm });
    expect(cold.builderPid).toBe(cold.pid);
    expect(warm.pid).not.toBe(cold.pid);
    expect(warm.builderPid).toBe(cold.pid);
    expect(warm.templateDir).toBe(cold.templateDir);
    expect(cold.templateDir.startsWith(isolated + path.sep)).toBe(true);
    for (const version of cold.versions) expect(version).toBeGreaterThan(0);
    expect(warm.versions).toEqual(cold.versions);
    expect(cold.publishedReport).toEqual({ success: true, error: null });
    expect(warm.publishedReport).toEqual({ success: true, error: null });
    expect(cold.report).toEqual({ success: true, error: null });
    expect(warm.report).toEqual({ success: true, error: null });
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
});
