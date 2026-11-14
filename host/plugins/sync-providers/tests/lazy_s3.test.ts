/** W12 冷启动：插件入口不加载 `@aws-sdk/client-s3`，第一次创建 S3 存储时才加载。独立进程里测，避免共享模块缓存。 */
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

const PROBE = `
const { createRequire } = await import('node:module');
const awsLoaded = () => Object.keys(createRequire(import.meta.url).cache).some(key => key.includes('@aws-sdk/client-s3'));
const entry = await import(${JSON.stringify(new URL('../index.ts', import.meta.url).href)});
const afterImport = awsLoaded();
const storage = await entry.createStorage({
  provider: 's3', root: 'probe',
  s3: { endpoint: 'https://s3.example.com', bucket: 'probe-bucket', accessKeyId: 'AKID', secretAccessKey: 'SECRET' },
});
console.log(JSON.stringify({ afterImport, afterCreate: awsLoaded(), provider: storage.providerName() }));
`;

it('importing the plugin entry leaves @aws-sdk/client-s3 unloaded until an S3 storage is created', () => {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', PROBE], { encoding: 'utf8' });
  expect(result.status, `probe failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
  expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({ afterImport: false, afterCreate: true, provider: 'S3' });
});
