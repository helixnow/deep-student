import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { SkillMarketVerifyResult } from '../api.ts';
import {
  cacheKey, classifyDownloadPayload, decodeSkillMarketProvenance, encodeSkillMarketProvenance,
  enrichVerify, enforceInstallVerdict, HttpSkillMarketTransport, normalizeExpectedSha256, parseRetryAfter,
  readBoundTempZip, ResponseCache, sanitizeSlug, shouldRemoveTempArtifact, skillMarketVersionOutdated,
  SkillMarket, SkillMarketClient, SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor,
  TEMP_ARTIFACT_MAX_AGE_MS, validateHandoffDescriptor, writeTempZip,
  type GitHubHandoff, type RawHttpResponse, type SkillMarketTransport,
} from '../src/skill-market.ts';
import { buildZip, readZipEntries } from '../src/zip.ts';
import { SkillFiles } from '../src/files.ts';
import { SkillPackages } from '../src/skill-package.ts';
import type { PathsService } from '../../../platform/paths/api.ts';
import type { HttpRequestInit, HttpService } from '../../../platform/http/api.ts';

class MockTransport implements SkillMarketTransport {
  responses: RawHttpResponse[];
  calls = 0;

  constructor(responses: RawHttpResponse[]) {
    this.responses = [...responses];
  }

  async send(_method: string, _url: string, _jsonBody?: unknown): Promise<RawHttpResponse> {
    this.calls++;
    if (!this.responses.length) throw new Error('MockTransport: no more responses');
    return this.responses.shift()!;
  }
}

const raw = (status: number, body: string | Uint8Array, headers: Record<string, string> = {}): RawHttpResponse => ({
  status,
  headers,
  body: typeof body === 'string' ? Buffer.from(body) : body,
});

function zipBytes(): Uint8Array {
  return buildZip([{ name: 'demo/SKILL.md', bytes: Buffer.from('---\nname: demo\ndescription: d\n---\n\n# demo\n') }]);
}

function handoffJson(): Uint8Array {
  return Buffer.from(JSON.stringify({
    sourceRef: 'public-github',
    repo: 'acme/skills',
    commit: 'abc1234',
    path: 'skills/demo',
    archiveUrl: 'https://codeload.github.com/acme/skills/zip/abc1234',
  }));
}

function repoZip(): Uint8Array {
  return buildZip([
    { name: 'acme-skills-abc1234/skills/demo/SKILL.md', bytes: Buffer.from('---\nname: demo\n---\nbody\n') },
  ]);
}

describe('skill_market_client.rs payloads', () => {
  it('classify_zip_by_magic', () => {
    const z = zipBytes();
    const payload = classifyDownloadPayload('application/octet-stream', z);
    expect(payload.kind).toBe('zip');
    if (payload.kind !== 'zip') throw new Error('expected zip');
    expect(payload.bytes).toEqual(z);
  });

  it('classify_github_handoff_json', () => {
    const payload = classifyDownloadPayload('application/json', handoffJson());
    expect(payload.kind).toBe('github-handoff');
    if (payload.kind !== 'github-handoff') throw new Error('expected handoff');
    expect(payload.handoff.sourceRef).toBe('public-github');
    expect(payload.handoff.repo).toBe('acme/skills');
    expect(payload.handoff.path).toBe('skills/demo');
    expect(payload.handoff.archiveUrl).toContain('codeload.github.com');
  });

  it('classify_rejects_unknown_json', () => {
    expect(() => classifyDownloadPayload('application/json', Buffer.from('{"hello":"world"}'))).toThrow();
  });

  it('handoff_rejects_wrong_host_or_ref', () => {
    const wrongHost: GitHubHandoff = {
      sourceRef: 'public-github', repo: 'acme/skills', commit: 'abc1234', path: 'skills/demo',
      archiveUrl: 'https://evil.example/acme/skills/zip/abc1234',
    };
    expect(() => validateHandoffDescriptor(wrongHost)).toThrow();
    const wrongRef: GitHubHandoff = { ...wrongHost, archiveUrl: 'https://codeload.github.com/acme/skills/zip/def456' };
    expect(() => validateHandoffDescriptor(wrongRef)).toThrow();
  });

  it('install_verdict_is_exact_and_fail_closed', () => {
    const verdict: SkillMarketVerifyResult = {
      ok: true, decision: 'allow', reasons: [], slug: 'demo', version: '1.0.0',
      securityStatus: 'passed', securityPassed: true, publisherHandle: 'acme', publisherDisplayName: 'Acme',
    };
    expect(() => enforceInstallVerdict(verdict, 'demo', '1.0.0')).not.toThrow();
    verdict.version = '1.0.1';
    expect(() => enforceInstallVerdict(verdict, 'demo', '1.0.0')).toThrow();
    verdict.version = '1.0.0';
    verdict.securityPassed = false;
    expect(() => enforceInstallVerdict(verdict, 'demo', '1.0.0')).toThrow();
  });

  it('stale_artifact_policy_and_consumption_cleanup', () => {
    expect(shouldRemoveTempArtifact(0, 60_000)).toBe(false);
    expect(shouldRemoveTempArtifact(0, TEMP_ARTIFACT_MAX_AGE_MS + 1000)).toBe(true);

    const bytes = zipBytes();
    const target = writeTempZip('cleanup-test', bytes);
    const { bytes: loaded, cleanup } = readBoundTempZip(target);
    expect(loaded).toEqual(bytes);
    expect(existsSync(target)).toBe(true);
    cleanup.dispose();
    expect(existsSync(target)).toBe(false);
  });

  it('parse_retry_after_seconds', () => {
    expect(parseRetryAfter({ 'retry-after': '7' })).toBe(7000);
  });
});

describe('skill_market_client.rs client', () => {
  it('respects_429_retry_after_then_succeeds', async () => {
    const transport = new MockTransport([
      raw(429, 'rate limited', { 'retry-after': '0' }),
      raw(200, '{"results":[{"slug":"demo","displayName":"Demo","downloads":1}]}'),
    ]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const result = await client.search('demo', 5, true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.slug).toBe('demo');
    expect(transport.calls).toBe(2);
  }, 10_000);

  it('cache_hit_skips_second_http_call', async () => {
    const cache = new ResponseCache();
    const transport = new MockTransport([]);
    const key = cacheKey('GET', 'https://clawhub.ai/api/v1/search?q=x&limit=1&nonSuspiciousOnly=true');
    const response = raw(200, '{"results":[{"slug":"cached","displayName":"Cached"}]}');
    cache.put(key, response);
    const hit = cache.get(key);
    expect(hit).toBeDefined();
    expect(Buffer.from(hit!.body)).toEqual(Buffer.from(response.body));
    const hit2 = cache.get(key);
    expect(hit2).toBeDefined();
    expect(JSON.parse(Buffer.from(hit2!.body).toString('utf8')).results[0].slug).toBe('cached');
    expect(transport.calls).toBe(0);
    cache.clear();
  });

  it('evicts oldest fresh responses when the cache exceeds 256 entries', () => {
    const cache = new ResponseCache();
    for (let index = 0; index < 300; index++) cache.put(String(index), raw(200, '{}'));
    expect(cache._entries.size).toBe(256);
    expect(cache.get('43')).toBeUndefined();
    expect(cache.get('44')).toBeDefined();
    expect(cache.get('299')).toBeDefined();
  });

  it('download_follows_github_handoff_branch', async () => {
    const transport = new MockTransport([
      raw(200, handoffJson(), { 'content-type': 'application/json' }),
      raw(200, repoZip(), { 'content-type': 'application/zip' }),
    ]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const pkg = await client.downloadPackageBytes('demo', '1.0.0');
    expect(pkg.sourceKind).toBe('github-handoff');
    expect(pkg.handoff).toBeDefined();
    const names = readZipEntries(pkg.bytes).map(entry => entry.name).sort();
    expect(names).toEqual(['demo/SKILL.md']);
    expect(transport.calls).toBe(2);
  });

  it('handoff_repack_content_failure_keeps_zip_error_context', async () => {
    const missingPathHandoff = Buffer.from(JSON.stringify({
      sourceRef: 'public-github',
      repo: 'acme/skills',
      commit: 'abc1234',
      path: 'skills/missing',
      archiveUrl: 'https://codeload.github.com/acme/skills/zip/abc1234',
    }));
    const transport = new MockTransport([
      raw(200, missingPathHandoff, { 'content-type': 'application/json' }),
      raw(200, repoZip(), { 'content-type': 'application/zip' }),
    ]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    await expect(client.downloadPackageBytes('demo', '1.0.0'))
      .rejects.toThrow(/^Handoff repack failed: No files found under skill directory 'skills\/missing'$/);
  });

  it('skill_detail_version_drives_outdated_check', async () => {
    const transport = new MockTransport([raw(200, `{
      "skill":{"slug":"sonoscli","displayName":"Sonos CLI","summary":"s"},
      "latestVersion":{"version":"1.2.0"},
      "owner":{"handle":"acme"}
    }`)]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const detail = await client.skillDetail('sonoscli');
    expect(detail.version).toBe('1.2.0');
    expect(skillMarketVersionOutdated('1.0.0', detail.version)).toBe(true);
    expect(skillMarketVersionOutdated('1.2.0', detail.version)).toBe(false);
    expect(transport.calls).toBe(1);
  });

  it('rate_limit_exhausted_returns_rate_limited_error', async () => {
    const transport = new MockTransport([
      raw(429, 'rate limited', { 'retry-after': '0' }),
      raw(429, 'rate limited', { 'retry-after': '0' }),
      raw(429, 'rate limited', { 'retry-after': '0' }),
    ]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    await expect(client.search('demo', 5, true)).rejects.toThrow(/^RATE_LIMITED:/);
    expect(transport.calls).toBe(3);
  }, 10_000);

  it('download_direct_zip_branch_without_handoff', async () => {
    const transport = new MockTransport([raw(200, zipBytes(), { 'content-type': 'application/zip' })]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const pkg = await client.downloadPackageBytes('demo', '2.0.0');
    expect(pkg.sourceKind).toBe('zip');
    expect(pkg.handoff).toBeUndefined();
    expect(pkg.version).toBe('2.0.0');
    expect(pkg.bytes).toEqual(zipBytes());
    expect(transport.calls).toBe(1);
  });

  it('download_respects_429_then_follows_handoff', async () => {
    const transport = new MockTransport([
      raw(429, 'slow down', { 'retry-after': '0' }),
      raw(200, handoffJson(), { 'content-type': 'application/json' }),
      raw(200, repoZip(), { 'content-type': 'application/zip' }),
    ]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const pkg = await client.downloadPackageBytes('demo', '1.0.0');
    expect(pkg.sourceKind).toBe('github-handoff');
    expect(pkg.handoff).toBeDefined();
    expect(transport.calls).toBe(3);
  }, 10_000);
});

describe('skill_market_client.rs provenance and versions', () => {
  it('provenance_format', () => {
    expect(encodeSkillMarketProvenance('sonoscli', '1.0.0')).toBe('skill_market:sonoscli@1.0.0');
  });

  it('decode_provenance_slug_and_version', () => {
    const [slug, version] = decodeSkillMarketProvenance('skill_market:sonoscli@1.0.0');
    expect(slug).toBe('sonoscli');
    expect(version).toBe('1.0.0');
  });

  it('decode_provenance_rejects_non_skill_market', () => {
    expect(() => decodeSkillMarketProvenance('https://example.com/pkg.zip')).toThrow();
  });

  it('version_outdated_marks_when_remote_differs', () => {
    expect(skillMarketVersionOutdated('1.0.0', '1.1.0')).toBe(true);
    expect(skillMarketVersionOutdated('1.1.0', '1.1.0')).toBe(false);
    expect(skillMarketVersionOutdated('1.0.0', '')).toBe(false);
    expect(skillMarketVersionOutdated('', '1.0.0')).toBe(true);
    expect(skillMarketVersionOutdated('1.0.0', '   ')).toBe(false);
    expect(skillMarketVersionOutdated(' 1.2.0 ', '1.2.0')).toBe(false);
  });
});

describe('skill_market_client.rs helper guards', () => {
  it('slug_and_digest_validation', () => {
    expect(sanitizeSlug('  demo.skill_1 ')).toBe('demo.skill_1');
    expect(() => sanitizeSlug('bad/slug')).toThrow();
    expect(() => sanitizeSlug('')).toThrow();
    expect(normalizeExpectedSha256('AA'.repeat(32))).toBe('aa'.repeat(32));
    expect(() => normalizeExpectedSha256('abc')).toThrow();
  });

  it('enrich_verify_attaches_badges_and_fills_owner', async () => {
    const transport = new MockTransport([raw(200, JSON.stringify({
      items: [{
        ok: true, decision: 'allow', slug: 'demo', version: '1.0.0',
        publisherHandle: 'acme', security: { status: 'passed', passed: true },
      }],
    }))]);
    const client = new SkillMarketClient(transport, new ResponseCache());
    const items = await enrichVerify(client, [{
      slug: 'demo', displayName: 'Demo', summary: '', version: '1.0.0', downloads: 0,
      ownerHandle: '', stars: 0,
    }, {
      slug: 'other', displayName: 'Other', summary: '', version: '', downloads: 0,
      ownerHandle: '', stars: 0,
    }]);
    expect(items[0]!.verify?.securityPassed).toBe(true);
    expect(items[0]!.ownerHandle).toBe('acme');
    expect(items[1]!.verify).toBeUndefined();
  });
});


describe('skill_market_client.rs install provenance', () => {
  it('persists_autosi_rfc3339_and_leaves_no_staging', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'market-install-'));
    try {
      const files = new SkillFiles(
        { os: { home: root, data: root }, appDataDir: root } as unknown as PathsService,
      );
      const packages = new SkillPackages(files);
      const transport = new MockTransport([
        raw(200, zipBytes(), { 'content-type': 'application/zip' }),
        raw(200, JSON.stringify({
          ok: true, decision: 'allow', reasons: [], slug: 'demo', version: '1.0.0',
          security: { status: 'passed', passed: true },
          publisherHandle: 'acme', publisherDisplayName: 'Acme',
        }), { 'content-type': 'application/json' }),
        raw(200, zipBytes(), { 'content-type': 'application/zip' }),
      ]);
      const saved: Record<string, string> = {};
      const market = new SkillMarket(
        new SkillMarketClient(transport, new ResponseCache()),
        packages,
        (key, value) => { saved[key] = value; },
        { warn: () => undefined },
      );
      const scan = await market.downloadAndScan('demo', '1.0.0', false, false, undefined, undefined, undefined);
      expect(scan.tempZipPath).toBeDefined();
      const base = files.expandPath('~/.deep-student/skills');
      await expect(market.downloadAndScan(
        'demo', '1.0.0', true, false,
        '0'.repeat(64), scan.tempZipPath, scan.scan.risk_level,
      )).rejects.toThrow(/changed after confirmation/);
      expect(readdirSync(base).filter(name => name.includes('.staging-'))).toEqual([]);

      const rescan = await market.downloadAndScan('demo', '1.0.0', false, false, undefined, undefined, undefined);
      const installed = await market.downloadAndScan(
        'demo', '1.0.0', true, false,
        rescan.scan.package_sha256, rescan.tempZipPath, rescan.scan.risk_level,
      );
      expect(installed.installed).toBe(true);
      const marker = JSON.parse(
        readFileSync(path.join(base, 'demo', 'AGENT_INSTALLED.json'), 'utf8'),
      ) as { installedAt: string };
      expect(marker.installedAt).toMatch(/\+00:00$/);
      expect(marker.installedAt).not.toMatch(/Z$/);
      expect(Number.isNaN(Date.parse(marker.installedAt))).toBe(false);
      expect(saved['skill.provenance.demo']).toBeDefined();
      expect(readdirSync(base).filter(name => name.includes('.staging-'))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function httpWith(fetch: (input: string | URL, init?: HttpRequestInit) => Promise<Response>): () => HttpService {
  return () => ({ fetch } as HttpService);
}

describe('skill_market_client.rs ctx.http transport deadline', () => {
  it('reuses_one_signal_across_the_whole_redirect_chain', async () => {
    const signals: AbortSignal[] = [];
    const calls: string[] = [];
    const http = httpWith(async (input, init) => {
      calls.push(String(input));
      signals.push(init?.signal as AbortSignal);
      if (calls.length === 1) {
        return new Response(null, { status: 302, headers: { location: 'https://github.com/acme/skills/zip/abc1234' } });
      }
      if (calls.length === 2) {
        return new Response(null, { status: 302, headers: { location: 'https://codeload.github.com/acme/skills/zip/abc1234' } });
      }
      return new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });
    });
    const response = await new HttpSkillMarketTransport(http).send(
      'GET', 'https://clawhub.ai/api/v1/search?q=x',
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(response.body).toString()).toBe('ok');
    expect(calls).toEqual([
      'https://clawhub.ai/api/v1/search?q=x',
      'https://github.com/acme/skills/zip/abc1234',
      'https://codeload.github.com/acme/skills/zip/abc1234',
    ]);
    expect(signals).toHaveLength(3);
    expect(signals[1]).toBe(signals[0]);
    expect(signals[2]).toBe(signals[0]);
  });

  it('propagates_abort_from_the_single_timeout_signal', async () => {
    const originalTimeout = AbortSignal.timeout;
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let seen: AbortSignal | undefined;
    const http = httpWith((_input, init) => new Promise<Response>((_resolve, reject) => {
      seen = init?.signal as AbortSignal;
      seen.addEventListener('abort', () => reject(new Error('aborted by deadline')), { once: true });
    }));
    try {
      const pending = new HttpSkillMarketTransport(http).send('GET', 'https://clawhub.ai/api/v1/search');
      const rejection = expect(pending).rejects.toThrow(
        'Community skill marketplace request failed: error sending request for url (https://clawhub.ai/api/v1/search): operation timed out',
      );
      controller.abort();
      await rejection;
      expect(seen).toBe(controller.signal);
      expect(timeout).toHaveBeenCalledTimes(1);
    } finally {
      timeout.mockRestore();
      AbortSignal.timeout = originalTimeout;
    }
  });
});

describe('skill_market_client.rs executors', () => {
  it('read_tool_executor_handles_search_and_detail_only', () => {
    const executor = new SkillMarketReadToolExecutor();
    expect(executor.canHandle('builtin-skill_market_search')).toBe(true);
    expect(executor.canHandle('builtin-skill_market_skill_detail')).toBe(true);
    expect(executor.canHandle('builtin-skill_market_download_and_scan')).toBe(false);
    expect(executor.canHandle('builtin-skill_market_verify')).toBe(false);
    expect(executor.sensitivityLevel('builtin-skill_market_search')).toBe('low');
  });

  it('install_tool_executor_classifies_scan_and_install_separately', () => {
    const executor = new SkillMarketInstallToolExecutor();
    expect(executor.canHandle('builtin-skill_market_verify')).toBe(true);
    expect(executor.canHandle('builtin-skill_market_download_and_scan')).toBe(true);
    expect(executor.canHandle('builtin-skill_market_search')).toBe(false);
    expect(executor.sensitivityLevelForCall(
      'builtin-skill_market_download_and_scan', { install: false },
    )).toBe('medium');
    expect(executor.sensitivityLevelForCall(
      'builtin-skill_market_download_and_scan', { install: true },
    )).toBe('high');
  });
});
