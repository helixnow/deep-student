#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export function nativeIdentity(target, env, frontend) {
  return {
    schema: 1, target, sourceSha: env.RELEASE_SOURCE_SHA, workflowSha: env.RELEASE_WORKFLOW_SHA,
    frontendSha256: frontend,
    profile: ['CARGO_PROFILE_RELEASE_LTO', 'CARGO_PROFILE_RELEASE_CODEGEN_UNITS', 'CARGO_PROFILE_RELEASE_DEBUG',
      'CARGO_PROFILE_RELEASE_SPLIT_DEBUGINFO', 'CARGO_PROFILE_RELEASE_OPT_LEVEL', 'RUSTFLAGS']
      .map((key) => [key, env[key] || '']),
  };
}
function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }); }
export function executionCommand(args, platform = process.platform, node = process.execPath) {
  // Execute npm's JS entrypoint on Windows: no cmd.exe JSON quoting and no
  // ambiguous bash.exe lookup (Git Bash vs the Windows WSL launcher).
  if (platform === 'win32') {
    return [node, [path.win32.join(path.win32.dirname(node), 'node_modules/npm/bin/npx-cli.js'), ...args]];
  }
  if (platform === 'darwin' && args[2] === 'build') return ['/usr/bin/time', ['-l', 'npx', ...args]];
  return ['npx', args];
}
function execute(args) {
  const [program, argv] = executionCommand(args);
  const r = spawnSync(program, argv, { stdio: 'inherit', env: process.env });
  if (r.error) throw r.error;
  return r.status ?? 1;
}
export async function bundleWithRetry(run, clean, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const status = run();
    if (!status || attempt === 3) return status;
    console.log(`::warning::Bundling failed; retry ${attempt}/2 using the existing native executable`);
    clean();
    await wait(15_000 * attempt);
  }
}
async function main() {
  const [command, target, bundles] = process.argv.slice(2);
  assert.ok(['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'x86_64-unknown-linux-gnu'].includes(target));
  if (process.env.ALLOW_UNSIGNED === '1') {
    for (const key of ['APPLE_SIGNING_IDENTITY', 'APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID']) delete process.env[key];
  }
  const config = process.env.FRONTEND_DIST_ARTIFACT ? ['--config', '{"build":{"beforeBuildCommand":""}}'] : [];
  const release = path.resolve('src-tauri/target', target, 'release');
  const binary = target.includes('windows') ? 'deep-student.exe' : 'deep-student';
  if (command === 'bundle') {
    assert.ok(existsSync(path.join(release, binary)), 'native executable missing; compile before bundling');
    const status = await bundleWithRetry(
      () => execute(['--no-install', 'tauri', 'bundle', '--ci', '--target', target, '--bundles', bundles, ...config]),
      // Only disposable bundler output is removed. Never invalidate Rust target/.
      () => rmSync(path.join(release, 'bundle'), { recursive: true, force: true }),
    );
    if (status) process.exit(status);
    return;
  }
  assert.equal(command, 'compile');
  const manifest = 'native-build.json';
  const frontendFile = 'dist/.deepstudent-release.json';
  const frontend = existsSync(frontendFile) ? JSON.parse(readFileSync(frontendFile, 'utf8')).distSha256 : '';
  const identity = nativeIdentity(target, process.env, frontend);
  const reusable = process.env.RELEASE_FORCE_REBUILD !== 'true' && /^[a-f0-9]{40}$/.test(identity.sourceSha || '') && frontend && process.env.GH_TOKEN;
  if (reusable) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'native-recovery-'));
    try {
      const repo = process.env.GITHUB_REPOSITORY;
      const runs = ['release.yml', 'rebuild-release.yml'].flatMap((w) =>
        JSON.parse(gh(['api', `repos/${repo}/actions/workflows/${w}/runs?head_sha=${identity.workflowSha}&per_page=20`])).workflow_runs)
        .sort((a, b) => b.id - a.id);
      for (const run of runs) {
        if (!['push', 'workflow_dispatch', 'workflow_run'].includes(run.event)) continue;
        const artifacts = JSON.parse(gh(['api', `repos/${repo}/actions/runs/${run.id}/artifacts?per_page=100`])).artifacts;
        const name = `native-${target}`;
        if (!artifacts.some((a) => a.name === name && !a.expired)) continue;
        const dest = path.join(dir, String(run.id));
        mkdirSync(dest);
        gh(['run', 'download', String(run.id), '--repo', repo, '--name', name, '--dir', dest]);
        const actual = JSON.parse(readFileSync(path.join(dest, manifest), 'utf8'));
        try { assert.deepEqual(actual, identity); } catch { continue; }
        assert.ok(existsSync(path.join(dest, binary)), 'recovery artifact missing executable');
        mkdirSync(release, { recursive: true });
        cpSync(dest, release, { recursive: true });
        if (process.platform !== 'win32') chmodSync(path.join(release, binary), 0o755);
        console.log(`Recovered compiled ${target} from run ${run.id}; Rust compilation skipped`);
        return;
      }
    } catch (error) {
      console.log(`::warning::Native recovery unavailable (${error.message}); compiling normally`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const status = execute(['--no-install', 'tauri', 'build', '--target', target, '--no-bundle', ...config, '--', '--locked']);
  if (status) process.exit(status);
  assert.ok(existsSync(path.join(release, binary)), 'compiler produced no executable');
  writeFileSync(path.join(release, manifest), JSON.stringify(identity, null, 2) + '\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
