/**
 * 打包产物脚本（__tests__/packaged-smoke.mjs / verify-fuses.mjs）共用：定位并复制 `.app`、隔离环境、读包内文件。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BLACKHOLE_PROXY = 'http://127.0.0.1:9';

export const defaultSourceApp = () => join(repoRoot, 'release', `mac-${process.arch}`, 'Deep Student.app');
export const workBase = () => {
  const base = join(realpathSync(tmpdir()), 'ds-packaged-smoke');
  mkdirSync(base, { recursive: true });
  return base;
};

export function isInside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

/**
 * 仓库内的 `.app` 先 `ditto` 到仓库外：仓库内运行时 Node 会沿父目录找到工作树的 node_modules，掩盖包内缺失的依赖。
 * 同一产物（Info.plist mtime 不变）复用已有副本。
 */
export function prepareApp(sourceApp) {
  if (!existsSync(join(sourceApp, 'Contents', 'Info.plist'))) {
    throw new Error(`no app bundle at ${sourceApp}: run \`node electron/scripts/package.mjs --mac --dir\` first`);
  }
  let appPath = sourceApp;
  if (isInside(realpathSync(sourceApp), repoRoot)) {
    const dir = join(workBase(), 'app');
    appPath = join(dir, basename(sourceApp));
    const stamp = join(dir, '.source-mtime');
    const key = `${sourceApp}\n${statSync(join(sourceApp, 'Contents', 'Info.plist')).mtimeMs}`;
    if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== key) {
      console.log(`copying ${sourceApp} -> ${appPath} (outside the repository)`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      execFileSync('ditto', [sourceApp, appPath]);
      writeFileSync(stamp, key);
    }
  }
  const contentsDir = join(appPath, 'Contents');
  return { appPath, contentsDir, executable: join(contentsDir, 'MacOS', basename(appPath, '.app')) };
}

/** 隔离环境（与 W12 冒烟 host/e2e/smoke/support/app.ts 相同）：数据、HOME、临时目录都在 `root` 下，外网走不可路由代理。 */
export function isolatedEnv(root, extra = {}) {
  for (const dir of ['home', 'tmp', 'data', 'config', 'cache', 'local', 'userdata', 'runtime']) mkdirSync(join(root, dir), { recursive: true, mode: 0o700 });
  const env = {
    ...process.env,
    HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    TMPDIR: join(root, 'tmp'), TMP: join(root, 'tmp'), TEMP: join(root, 'tmp'),
    XDG_DATA_HOME: join(root, 'local'), XDG_CONFIG_HOME: join(root, 'config'), XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), APPDATA: join(root, 'config'), LOCALAPPDATA: join(root, 'local'),
    DS_APP_DATA_DIR: join(root, 'data'), DS_ELECTRON_USER_DATA: join(root, 'userdata'),
    DEEP_STUDENT_KEY_SEED_FILE_ONLY: '1',
    HTTP_PROXY: BLACKHOLE_PROXY, HTTPS_PROXY: BLACKHOLE_PROXY, ALL_PROXY: BLACKHOLE_PROXY,
    http_proxy: BLACKHOLE_PROXY, https_proxy: BLACKHOLE_PROXY, all_proxy: BLACKHOLE_PROXY,
    NO_PROXY: '127.0.0.1,localhost,::1', no_proxy: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1',
  };
  for (const key of Object.keys(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key === 'NODE_OPTIONS' || key === 'DEEP_STUDENT_BUILD_NUMBER' || key === 'X1_TRACE'
      || (key.startsWith('DS_') && key !== 'DS_APP_DATA_DIR' && key !== 'DS_ELECTRON_USER_DATA')) delete env[key];
  }
  return { ...env, ...extra };
}

/** 读包内应用文件：`Resources/app.asar`（asar 打包）或 `Resources/app/`。 */
export function readAppFile(contentsDir, file) {
  const archive = join(contentsDir, 'Resources', 'app.asar');
  if (existsSync(archive)) return require('@electron/asar').extractFile(archive, file).toString('utf8');
  return readFileSync(join(contentsDir, 'Resources', 'app', ...file.split('/')), 'utf8');
}
