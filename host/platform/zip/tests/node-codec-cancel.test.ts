/**
 * `nodeZipCodec` 的 Web 读端在 zlib 仍有缓冲输出时被取消（例如条目解压超出声明大小、写入中途放弃），
 * 不能留下未捕获的 ERR_INVALID_STATE：Node `Duplex.toWeb` 读端取消后，已排好的 `resume` 仍会 enqueue。
 * 在子进程里跑，未捕获异常直接计数，而不是只在 vitest 的 Unhandled Errors 里出现。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const FILE = fileURLToPath(new URL('../node/file.ts', import.meta.url));

const PROBE = `
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
const { nodeZipCodec } = await import(pathToFileURL(process.argv[1]).href);
const counts = { inflate: 0, deflate: 0 };
let current = 'inflate';
process.on('uncaughtException', () => { counts[current] += 1; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function cancelWithBufferedOutput(pair, input, settleMs) {
  const writer = pair.writable.getWriter();
  writer.write(input).catch(() => undefined);
  writer.close().catch(() => undefined);
  const reader = pair.readable.getReader();
  await sleep(settleMs);
  await reader.read();
  await reader.cancel(new Error('stop'));
  await writer.abort(new Error('stop')).catch(() => undefined);
  await sleep(2);
}
const ROUNDS = 20;
const zeros = zlib.deflateRawSync(Buffer.alloc(64 * 1024 * 1024));
for (let i = 0; i < ROUNDS; i += 1) await cancelWithBufferedOutput(nodeZipCodec.inflateRaw(), zeros, 5);
current = 'deflate';
const noise = randomBytes(8 * 1024 * 1024);
for (let i = 0; i < ROUNDS; i += 1) await cancelWithBufferedOutput(nodeZipCodec.deflateRaw(), noise, 60);
console.log(JSON.stringify({ ...counts, rounds: ROUNDS }));
`;

it('cancelling inflate/deflate with buffered zlib output leaves no uncaught exception behind', () => {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE, FILE], { encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ inflate: 0, deflate: 0, rounds: 20 });
});
