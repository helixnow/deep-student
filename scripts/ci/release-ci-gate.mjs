#!/usr/bin/env node
// Only a CI push run checks the exact commit (a PR run normally checks a merge ref).
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function selectCiRun(runs, sourceSha) {
  return runs.filter((run) => run.head_sha === sourceSha && run.event === 'push')
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id)[0];
}
export async function waitForCi({ sourceSha, repo, token, apiUrl = 'https://api.github.com',
  fetchImpl = fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = console.log, timeoutMs = 150 * 60_000, missingGraceMs = 120_000, intervalMs = 30_000 }) {
  assert.match(sourceSha ?? '', /^[a-f0-9]{40}$/u, 'CI gate requires a full source SHA');
  assert.match(repo ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, 'invalid GitHub repository');
  assert.ok(token, 'GitHub Actions read token is missing');
  const start = now();
  const url = `${apiUrl}/repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sourceSha}&per_page=50`;
  let lastState = '';
  while (now() - start < timeoutMs) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      log('CI API request unavailable; retrying within the bounded wait');
      await sleep(intervalMs); continue;
    }
    if (response.status === 429 || response.status >= 500) {
      log(`CI API temporarily unavailable (HTTP ${response.status})`);
      await sleep(intervalMs); continue;
    }
    assert.ok(response.ok, `Cannot read CI evidence (HTTP ${response.status}); actions:read is required`);
    const data = await response.json();
    assert.ok(Array.isArray(data.workflow_runs), 'invalid CI API response');
    const run = selectCiRun(data.workflow_runs, sourceSha);
    if (!run) {
      assert.ok(now() - start < missingGraceMs,
        `No CI push-run evidence for ${sourceSha}; do not release an unverified commit. Run CI for this commit or choose a verified candidate.`);
    } else {
      const state = `${run.id}/${run.run_attempt}/${run.status}/${run.conclusion}`;
      if (state !== lastState) log(`CI for ${sourceSha}: ${run.status}/${run.conclusion || 'pending'} ${run.html_url}`);
      lastState = state;
      if (run.status === 'completed') {
        assert.equal(run.conclusion, 'success', `Required CI did not pass for ${sourceSha}: ${run.conclusion} (${run.html_url})`);
        return run;
      }
      assert.ok(!['action_required', 'waiting'].includes(run.status), 'CI needs approval; approve the source run before releasing');
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for successful CI on ${sourceSha}; no platform build was authorized`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  waitForCi({ sourceSha: process.env.RELEASE_SOURCE_SHA, repo: process.env.GITHUB_REPOSITORY,
    token: process.env.GH_TOKEN, apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    timeoutMs: Number(process.env.RELEASE_CI_WAIT_MS || 60_000), missingGraceMs: 30_000 })
    .then((run) => console.log(`[release-ci-gate] verified CI run ${run.id} on ${run.head_sha}`))
    .catch((error) => { console.error(`[release-ci-gate] ${error.message}`); process.exitCode = 1; });
}
