// 作业 TMPDIR 的位置。产品代码按 Rust deny_hidden_local_path（electron/file-ops.ts denyHiddenLocalPath）
// 拒绝含隐藏段的本地路径；测试夹具多由 os.tmpdir() 派生，所以 TMPDIR 本身绝不能落在隐藏目录里。
// 默认取作业目录（~/.oc-jobs）的非隐藏同级目录 ~/oc-jobs-tmp；OC_JOBS_TMP_DIR 可覆盖。
import os from 'node:os';
import path from 'node:path';

/** 与 electron/file-ops.ts hasHiddenComponent 同一规则。 */
export function hasHiddenComponent(p) {
  return p
    .split(/[\\/]/)
    .filter((c) => c !== '' && c !== '.' && c !== '..')
    .some((c) => c.startsWith('.'));
}

/**
 * @param {{ jobsDir: string, env?: Record<string, string | undefined>, osTmpdir?: string, user?: string }} options
 */
export function jobTmpRoot({ jobsDir, env = process.env, osTmpdir = os.tmpdir(), user = safeUser() }) {
  const override = env.OC_JOBS_TMP_DIR;
  if (override) {
    if (!path.isAbsolute(override)) throw new Error(`OC_JOBS_TMP_DIR must be an absolute path, got ${override}`);
    const resolved = path.resolve(override);
    if (hasHiddenComponent(resolved)) throw new Error(`OC_JOBS_TMP_DIR must not contain hidden path components: ${resolved}`);
    return resolved;
  }
  const jobs = path.resolve(jobsDir);
  const sibling = path.join(path.dirname(jobs), `${path.basename(jobs).replace(/^\.+/, '')}-tmp`);
  if (!hasHiddenComponent(sibling)) return sibling;
  const fallback = path.join(path.resolve(osTmpdir), `oc-jobs-tmp-${user}`);
  if (!hasHiddenComponent(fallback)) return fallback;
  throw new Error(`no job TMPDIR without hidden path components (tried ${sibling}, ${fallback}); set OC_JOBS_TMP_DIR`);
}

export function jobTmpDir(jobId, options) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(jobId)) throw new Error(`invalid job id for TMPDIR: ${JSON.stringify(jobId)}`);
  return path.join(jobTmpRoot(options), jobId);
}

function safeUser() {
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_') || String(process.getuid?.() ?? 'user');
  } catch {
    return String(process.getuid?.() ?? 'user');
  }
}
