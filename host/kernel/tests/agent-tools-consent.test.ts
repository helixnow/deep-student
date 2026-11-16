/**
 * 智能体工具 / 模型权限与安装同意（K3）：给已同意的插件加上 `agentTools`（随之出现 `agent:tools`、`net:<主机>`）
 * 或 `service:pluginModel`，权限摘要随之改变，装载前门回到确认；只改工具声明而权限不变时，由绑定的内容摘要拦下。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommunityConsentLedger, permissionsDigest, releaseContentDigest } from '../community-consent.ts';
import { checkManifest, type PluginManifest } from '../manifest.ts';
import { consentProblem } from '../plugin-admin.ts';

const ID = 'alice.timetable';
const TOOL = { name: 'lookup_timetable', title: '查课表', description: '读取教务日历，返回某一天的课程。' };

function manifest(ds: Record<string, unknown>, version = '1.0.0'): PluginManifest {
  const result = checkManifest({
    name: 'deepstudent-plugin-timetable', version, engines: { deepStudent: '>=0.20.0 <1.0.0' },
    deepStudent: { manifestVersion: 1, id: ID, platforms: ['desktop'], host: './index.ts', ...ds },
  }, { appVersion: '0.20.1', context: 'community-install', platform: 'desktop' });
  if (!result.ok) throw result.error;
  return result.manifest;
}

const PLAIN = { permissions: ['service:storage'] };
const WITH_TOOL = { permissions: ['service:storage', 'agent:tools', 'net:calendar.example.edu.cn'], agentTools: [TOOL] };
const WITH_MODEL = { permissions: ['service:storage', 'service:pluginModel'] };
const release = (packageJsonHash: string) => ({ files: { 'package.json': packageJsonHash.repeat(64), 'dist/host.js': 'b'.repeat(64) } });

let dir: string;
let ledger: CommunityConsentLedger;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ds-agent-tools-consent-'));
  ledger = new CommunityConsentLedger(dir);
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const grant = (value: PluginManifest, files?: { files: Record<string, string> }) => ledger.grant({
  id: value.id, version: value.version, permissions: value.permissions,
  ...(files ? { contentDigest: releaseContentDigest(files.files) } : {}),
}, { trust: 'full', source: 'workshop' });

describe('consent re-prompts when a plugin gains agent tools or the model', () => {
  it('declaring agent tools changes the permission digest, so a consented plugin asks again', async () => {
    const before = manifest(PLAIN), after = manifest(WITH_TOOL);
    expect(permissionsDigest(after.permissions)).not.toBe(permissionsDigest(before.permissions));
    await grant(before);
    expect(await consentProblem(ledger, before)).toEqual({ trust: 'full' });
    // 同一版本号也不能沿用：用户没见过「新增工具」与「联网读取」这两项。
    expect(await consentProblem(ledger, after)).toMatch(/has no matching consent record \(permissions\)/);
    const decision = await ledger.evaluate({ id: after.id, version: after.version, permissions: after.permissions });
    expect(decision).toMatchObject({ matched: false, code: 'CONSENT_REQUIRED', reason: 'permissions' });
    // 已同意的旧权限仍是交集，新权限不会被默认授予。
    expect(decision.grantedPermissions).toEqual(['service:storage']);
  });

  it('declaring service:pluginModel asks again as well', async () => {
    await grant(manifest(PLAIN));
    expect(await consentProblem(ledger, manifest(WITH_MODEL))).toMatch(/\(permissions\)/);
  });

  it('a new version with the tool asks again, and consent to it then matches', async () => {
    await grant(manifest(PLAIN));
    const next = manifest(WITH_TOOL, '1.1.0');
    expect(await consentProblem(ledger, next)).toMatch(/\(version\)/);
    await grant(next);
    expect(await consentProblem(ledger, next)).toEqual({ trust: 'full' });
  });

  it('changing only the tool declarations under the same permissions is caught by the bound content digest', async () => {
    const first = manifest(WITH_TOOL);
    await grant(first, release('a'));
    expect(await consentProblem(ledger, first, release('a'))).toEqual({ trust: 'full' });
    // 例如把工具改成 high 或换了说明：permissions 不变，package.json 的字节变了。
    const edited = manifest({ ...WITH_TOOL, agentTools: [{ ...TOOL, description: '另一种说法', sensitivity: 'high' }] });
    expect(permissionsDigest(edited.permissions)).toBe(permissionsDigest(first.permissions));
    expect(await consentProblem(ledger, edited, release('c'))).toMatch(/\(content\)/);
  });

  it('removing the tool also changes the subject: the narrower set is confirmed, not silently inherited', async () => {
    await grant(manifest(WITH_TOOL));
    expect(await consentProblem(ledger, manifest(PLAIN))).toMatch(/\(permissions\)/);
  });
});
