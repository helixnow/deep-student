// 测试环境的构建号兜底。electron/build-info.ts 与 src-tauri/build.rs 一样，没有 DEEP_STUDENT_BUILD_NUMBER
// 覆盖时从基线提交数起；浅克隆、源码快照里没有基线提交就会抛错。生产语义不动，只在 vitest 配置里
// 为“没有覆盖、没有打包的 version.json、也找不到基线提交”的工作树补一个测试默认值。
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** 必须与 electron/build-info.ts 的 baseline 相同（测试会校验）。 */
export const BUILD_BASELINE = '64edcb7735e5d4e6ccad6f13514b9ee0a8867c78';
export const TEST_BUILD_NUMBER = '20000';

export function baselineAvailable(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore', timeout: 10_000 });
  try {
    git('cat-file', '-e', `${BUILD_BASELINE}^{commit}`);
    git('merge-base', '--is-ancestor', BUILD_BASELINE, 'HEAD');
    return true;
  } catch {
    return false;
  }
}

/** 返回需要合并进 vitest `test.env` 的变量；能按生产规则算出构建号时返回空对象。 */
export function testBuildNumberEnv(root, { env = process.env, hasBaseline = baselineAvailable } = {}) {
  if (env.DEEP_STUDENT_BUILD_NUMBER !== undefined) return {};
  if (existsSync(path.join(root, 'electron', '.build', 'version.json'))) return {};
  return hasBaseline(root) ? {} : { DEEP_STUDENT_BUILD_NUMBER: TEST_BUILD_NUMBER };
}
