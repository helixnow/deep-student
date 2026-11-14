/**
 * Node 模块编译缓存（STARTUP-PROFILE.md）：Host 启动的大头是 profile 的动态导入——每个 `.ts` 都要剥离类型、
 * 再由 V8 编译。启用 `module.enableCompileCache()` 后，这两步的结果按文件内容哈希与 Node 版本缓存，内容变化时
 * 自动失效；不改变模块的加载顺序与求值语义。缓存目录由外壳经 `NODE_COMPILE_CACHE` 指定；单独运行 Host 时才落到
 * `os.tmpdir()`。
 *
 * 必须在加载 profile 之前执行（main.ts 第一个 import）。`NODE_DISABLE_COMPILE_CACHE=1` 关闭。
 */
import * as nodeModule from 'node:module';

type CompileCacheApi = {
  enableCompileCache?: (directory?: string) => unknown;
  flushCompileCache?: () => void;
};

const api = nodeModule as unknown as CompileCacheApi;

// 缓存只是加速：启用或写盘失败时按未缓存运行，只在 stderr 留一行（与 main.ts 的启动诊断同一出口）。
const report = (step: string, error: unknown) =>
  void process.stderr.write(`[dstu-host] compile cache ${step} failed: ${error instanceof Error ? error.message : String(error)}\n`);

try {
  api.enableCompileCache?.();
} catch (error) {
  report('enable', error);
}

/**
 * 立即把已积累的缓存写盘。Node 只在进程正常退出时自动写盘，而 Electron 可能直接结束 Host，
 * 所以 HostReady 之后（启动阶段的模块都已加载）调用一次。
 */
export function flushCompileCache(): void {
  try {
    api.flushCompileCache?.();
  } catch (error) {
    report('flush', error);
  }
}
