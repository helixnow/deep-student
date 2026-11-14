// vitest.host.config.ts 的 setupFiles：每个测试文件开始前执行。
import { clearProxyEnv } from './host-test-env.mjs';

clearProxyEnv(process.env);
if (typeof process.versions.electron === 'string') process.noAsar = true;
