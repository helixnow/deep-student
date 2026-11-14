import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_INSTALLED_MARKER } from '../src/tools/skill-install-executor.ts';
import { SkillWorkshopExecutor } from '../src/tools/skill-workshop-executor.ts';
import { SKILL_FILE_NAME } from '../src/tools/skill-workshop-package.ts';
import {
  PROPOSAL_META_FILE, proposalRevisionSha256, readProposalMeta, writeProposalMeta,
} from '../src/tools/skill-workshop-proposals.ts';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop-json-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const base = {
  proposalId: 'wp_1234567890_abcd', action: 'propose_update', skillId: 'demo',
  contentSha256: 'c', createdAt: 't', sessionId: 'sess', status: 'pending',
};
const metaJson = (tail: string) => `${JSON.stringify(base).slice(0, -1)},${tail}}`;
function readRaw(text: string) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), text);
  return readProposalMeta(dir);
}

describe('X6-UD-0004/0005 workshop persisted JSON (serde structs, not Value)', () => {
  it('keeps u64/usize exact through reading, approval hashing and status rewrite', () => {
    const dir = tempDir();
    const file = path.join(dir, PROPOSAL_META_FILE);
    fs.writeFileSync(file, metaJson('"packageVersion":9007199254740993,"files":[{"path":"SKILL.md","sha256":"h","size":18446744073709551615}]'));
    const meta = readProposalMeta(dir);
    expect(meta.packageVersion).toBe(9007199254740993n);
    expect(meta.files[0]!.size).toBe(18446744073709551615n);
    const adjacent = { ...meta, packageVersion: 9007199254740992n };
    expect(proposalRevisionSha256(meta)).not.toBe(proposalRevisionSha256(adjacent));
    writeProposalMeta(dir, { ...meta, status: 'rejected' });
    const written = fs.readFileSync(file, 'utf8');
    expect(written).toContain('"packageVersion": 9007199254740993');
    expect(written).toContain('"size": 18446744073709551615');
    expect(readProposalMeta(dir)).toEqual({ ...meta, status: 'rejected' });
  });

  it.each(['1.0', '1e0', '-0', '18446744073709551616'])(
    'rejects the non-u64 token %s rather than normalizing it with JSON.parse', token => {
      expect(() => readRaw(metaJson(`"packageVersion":${token}`)))
        .toThrow(/Invalid PROPOSAL\.json: invalid type: floating point .*expected u64 at line 1 column/);
    },
  );

  it('rejects duplicate known fields, including a second Option after null', () => {
    expect(() => readRaw(metaJson('"status":"applied"'))).toThrow('duplicate field `status`');
    expect(() => readRaw(metaJson('"previousSha256":null,"previousSha256":"h"')))
      .toThrow('duplicate field `previousSha256`');
    expect(readRaw(metaJson('"extra":1,"extra":2')).status).toBe('pending');
  });

  it('reports the first field error before later syntax errors', () => {
    expect(() => readRaw('{"status":7,"files":!}'))
      .toThrow('invalid type: integer `7`, expected a string at line 1 column 11');
  });

  it.each([
    ['9007199254740993', 9007199254740994n],
    ['18446744073709551615', 18446744073709551615n],
    ['1.0', 1],
  ] as const)('propose_update reads marker %s and uses Rust saturating_add', (raw, expected) => {
    const root = tempDir();
    const skillsBase = path.join(root, 'skills');
    const skillDir = path.join(skillsBase, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    const content = '---\nname: demo\n---\nbody';
    fs.writeFileSync(path.join(skillDir, SKILL_FILE_NAME), content);
    const marker = {
      sourceKind: 'agent_workshop', proposalId: base.proposalId, contentSha256: 'c',
      installedAt: 't', sessionId: 'sess',
    };
    fs.writeFileSync(path.join(skillDir, AGENT_INSTALLED_MARKER),
      `${JSON.stringify(marker).slice(0, -1)},"packageVersion":${raw}}`);
    const proposalsRoot = path.join(root, 'proposals');
    const executor = new SkillWorkshopExecutor({ proposalsRoot, skillsBase, sessionId: 'sess' });
    const result = executor.propose({ action: 'propose_update', skill_id: 'demo', content });
    const meta = readProposalMeta(path.join(proposalsRoot, String(result.proposal_id)));
    expect(meta.packageVersion).toBe(expected);
    expect(result.proposal_revision).toBe(proposalRevisionSha256(meta));
  });

  it('internal receipts retain the exact version through propose, list and apply', () => {
    const root = tempDir();
    const skillsBase = path.join(root, 'skills');
    const skillDir = path.join(skillsBase, 'demo');
    fs.mkdirSync(skillDir, { recursive: true });
    const content = '---\nname: demo\n---\nbody';
    fs.writeFileSync(path.join(skillDir, SKILL_FILE_NAME), content);
    fs.writeFileSync(path.join(skillDir, AGENT_INSTALLED_MARKER),
      '{"sourceKind":"agent_workshop","proposalId":"wp_1234567890_abcd",'
      + '"contentSha256":"c","installedAt":"t","sessionId":"sess",'
      + '"packageVersion":18446744073709551615}');
    const executor = new SkillWorkshopExecutor({
      proposalsRoot: path.join(root, 'proposals'), skillsBase, sessionId: 'sess',
    });
    const proposed = executor.propose({ action: 'propose_update', skill_id: 'demo', content });
    expect(proposed.package_version).toBe(18446744073709551615n);
    expect(executor.propose({ action: 'list' })).toMatchObject({
      pending: [{ package_version: 18446744073709551615n }], count: 1,
    });
    const applied = executor.apply({
      proposal_id: proposed.proposal_id, skill_id: 'demo',
      expected_content_sha256: proposed.content_sha256,
      expected_proposal_revision: proposed.proposal_revision,
    });
    expect(applied.applied).toBe(true);
    expect(applied.package_version).toBe(18446744073709551615n);
  });

  it('internal receipts retain the exact persisted file size in list results', () => {
    const root = tempDir();
    const dir = path.join(root, 'proposals', base.proposalId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), metaJson(
      '"files":[{"path":"SKILL.md","sha256":"h","size":9007199254740993}]',
    ));
    const executor = new SkillWorkshopExecutor({
      proposalsRoot: path.dirname(dir), skillsBase: path.join(root, 'skills'), sessionId: 'sess',
    });
    expect(executor.propose({ action: 'list' })).toMatchObject({
      pending: [{ files: [{ path: 'SKILL.md', size: 9007199254740993n }] }], count: 1,
    });
  });
});

// WP-030: serde derive visit_seq / IgnoredAny for ProposalMeta, ProposalFileMeta and
// AgentWorkshopMarker (skill_workshop_executor.rs:47-108), driven through the production
// SkillWorkshopExecutor file paths (PROPOSAL.json read/rewrite, marker read on propose_update).
const SKILL_TEXT = '---\nname: demo\n---\nbody';
function workshop() {
  const root = tempDir();
  const skillsBase = path.join(root, 'skills');
  const proposalsRoot = path.join(root, 'proposals');
  const executor = new SkillWorkshopExecutor({ proposalsRoot, skillsBase, sessionId: 'sess' });
  return { root, skillsBase, proposalsRoot, executor };
}
/** ProposalMeta declaration order; absent Option fields are null placeholders. */
function proposalSeq(meta: Record<string, unknown>, packageVersionToken: string): string {
  const files = (list: unknown) => (list as { path: string; sha256: string; size: unknown }[])
    .map(file => [file.path, file.sha256, Number(file.size)]);
  const head = JSON.stringify([
    meta.proposalId, meta.action, meta.skillId, meta.contentSha256, meta.createdAt, meta.sessionId,
    meta.status, meta.previousSha256 ?? null, meta.packageSha256 ?? null, files(meta.files),
    meta.previousPackageSha256 ?? null, files(meta.previousFiles),
  ]);
  return `${head.slice(0, -1)},${packageVersionToken}]`;
}
function rejectRaw(text: string): () => unknown {
  const { proposalsRoot, executor } = workshop();
  const dir = path.join(proposalsRoot, base.proposalId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), text);
  return () => executor.propose({ action: 'reject', proposal_id: base.proposalId });
}
const seven = JSON.stringify(Object.values(base));
const sevenPlus = (tail: string) => `${seven.slice(0, -1)},${tail}]`;
function updateWithMarker(markerText: string) {
  const env = workshop();
  const skillDir = path.join(env.skillsBase, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, SKILL_FILE_NAME), SKILL_TEXT);
  fs.writeFileSync(path.join(skillDir, AGENT_INSTALLED_MARKER), markerText);
  const result = env.executor.propose({ action: 'propose_update', skill_id: 'demo', content: SKILL_TEXT });
  const meta = readProposalMeta(path.join(env.proposalsRoot, String(result.proposal_id)));
  expect(result.package_version).toBe(meta.packageVersion);
  return meta.packageVersion;
}
const markerHead = '"agent_workshop","wp_1234567890_abcd","c","p"';

describe('WP-030 workshop serde sequence form and IgnoredAny (production executor paths)', () => {
  it('ProposalMeta/ProposalFileMeta sequence form: list, apply and status rewrite keep exact u64', () => {
    const { proposalsRoot, skillsBase, executor } = workshop();
    const created = executor.propose({ action: 'propose_create', skill_id: 'demo', content: SKILL_TEXT });
    const dir = path.join(proposalsRoot, String(created.proposal_id));
    const meta = readProposalMeta(dir) as unknown as Record<string, unknown>;
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), proposalSeq(meta, '18446744073709551615'));

    const listed = executor.propose({ action: 'list' }) as { pending: Record<string, unknown>[]; count: number };
    expect(listed.count).toBe(1);
    expect(listed.pending[0]).toMatchObject({
      proposal_id: created.proposal_id, package_version: 18446744073709551615n,
      files: [{ path: SKILL_FILE_NAME, sha256: created.content_sha256, size: SKILL_TEXT.length }],
    });
    expect(listed.pending[0]!.proposal_revision).not.toBe(created.proposal_revision);

    const applied = executor.apply({
      proposal_id: created.proposal_id, skill_id: 'demo',
      expected_content_sha256: created.content_sha256,
      expected_proposal_revision: listed.pending[0]!.proposal_revision,
    });
    expect(applied).toMatchObject({ applied: true, package_version: 18446744073709551615n });
    expect(readProposalMeta(dir)).toMatchObject({ status: 'applied', packageVersion: 18446744073709551615n });
    const marker = fs.readFileSync(path.join(skillsBase, 'demo', AGENT_INSTALLED_MARKER), 'utf8');
    expect(marker).toContain('"packageVersion": 18446744073709551615');
  });

  it('ProposalMeta sequence of 7 elements applies with serde defaults (files [], packageVersion 1)', () => {
    const { proposalsRoot, skillsBase, executor } = workshop();
    const created = executor.propose({ action: 'propose_create', skill_id: 'demo', content: SKILL_TEXT });
    const dir = path.join(proposalsRoot, String(created.proposal_id));
    const meta = readProposalMeta(dir);
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), JSON.stringify([
      meta.proposalId, meta.action, meta.skillId, meta.contentSha256, meta.createdAt, meta.sessionId, meta.status,
    ]));
    const defaults = readProposalMeta(dir);
    expect(defaults).toEqual({
      proposalId: meta.proposalId, action: 'propose_create', skillId: 'demo',
      contentSha256: meta.contentSha256, createdAt: meta.createdAt, sessionId: 'sess', status: 'pending',
      files: [], previousFiles: [], packageVersion: 1,
    });
    const applied = executor.apply({
      proposal_id: created.proposal_id, skill_id: 'demo',
      expected_content_sha256: created.content_sha256,
      expected_proposal_revision: proposalRevisionSha256(defaults),
    });
    expect(applied).toMatchObject({ applied: true, package_version: 1 });
    const marker = fs.readFileSync(path.join(skillsBase, 'demo', AGENT_INSTALLED_MARKER), 'utf8');
    expect(marker).toContain('"packageVersion": 1');
  });

  it('reject rewrites a sequence-form PROPOSAL.json as the serialized struct', () => {
    const { proposalsRoot, executor } = workshop();
    const dir = path.join(proposalsRoot, base.proposalId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), sevenPlus('null,null,[],null,[],5'));
    expect(executor.propose({ action: 'reject', proposal_id: base.proposalId }))
      .toMatchObject({ status: 'rejected', skill_id: 'demo' });
    expect(JSON.parse(fs.readFileSync(path.join(dir, PROPOSAL_META_FILE), 'utf8')))
      .toMatchObject({ ...base, status: 'rejected', packageVersion: 5 });
  });

  it.each([
    ['6 elements', JSON.stringify(Object.values(base).slice(0, 6)),
      (t: string) => `invalid length 6, expected struct ProposalMeta with 13 elements at line 1 column ${t.length}`],
    ['empty sequence', '[]', () => 'invalid length 0, expected struct ProposalMeta with 13 elements at line 1 column 2'],
    ['14 elements', sevenPlus('null,null,[],null,[],1,"x"'),
      (t: string) => `trailing characters at line 1 column ${t.length - 3}`],
    ['trailing comma', sevenPlus('null,null,[],null,[],1,'),
      (t: string) => `trailing comma at line 1 column ${t.length}`],
    ['unterminated', `${seven.slice(0, -1)},null,null,[],null,[],1`,
      (t: string) => `EOF while parsing a list at line 1 column ${t.length}`],
    ['short ProposalFileMeta', sevenPlus('null,null,[["SKILL.md","h"]]'),
      (t: string) => `invalid length 2, expected struct ProposalFileMeta with 3 elements at line 1 column ${t.indexOf(']]') + 1}`],
    ['extra ProposalFileMeta element', sevenPlus('null,null,[["SKILL.md","h",1,2]]'),
      (t: string) => `trailing characters at line 1 column ${t.indexOf(',2]]') + 2}`],
    ['wrong element type', `["wp_1",7]`,
      () => 'invalid type: integer `7`, expected a string at line 1 column 9'],
    ['float u64 element', sevenPlus('null,null,[],null,[],1.0'),
      (t: string) => `invalid type: floating point \`1.0\`, expected u64 at line 1 column ${t.length - 1}`],
    ['scalar instead of struct', '"x"', () => 'invalid type: string "x", expected struct ProposalMeta at line 1 column 3'],
  ] as const)('ProposalMeta sequence error position: %s', (_name, text, message) => {
    expect(rejectRaw(text)).toThrow(`Invalid PROPOSAL.json: ${message(text)}`);
  });

  it.each([
    ['sequence with exact u64', `[${markerHead},18446744073709551614,[["SKILL.md","h",1]],null,"t","sess"]`, 18446744073709551615n],
    ['3 elements (Option without default is required in sequence form)', `[${markerHead.split(',').slice(0, 3).join(',')}]`, 1],
    ['sequence missing installedAt/sessionId', `[${markerHead},41,[],null]`, 1],
    ['sequence without Option placeholder', `[${markerHead},41,[],"t","sess"]`, 1],
    ['sequence with Option placeholder', `[${markerHead},41,[],null,"t","sess"]`, 42],
    ['sequence with a trailing element', `[${markerHead},41,[],null,"t","sess",0]`, 1],
    ['map without Option field', '{"sourceKind":"a","proposalId":"p","contentSha256":"c","installedAt":"t","sessionId":"s","packageVersion":41}', 42],
  ] as const)('AgentWorkshopMarker %s → propose_update version', (_name, markerText, expected) => {
    expect(updateWithMarker(markerText)).toBe(expected);
  });

  it('unknown fields use IgnoredAny: no recursion limit, no surrogate pairing, lexical errors only', () => {
    const deep = `${'['.repeat(200)}${']'.repeat(200)}`;
    expect(readRaw(metaJson(`"extra":${deep}`)).status).toBe('pending');
    expect(readRaw(metaJson('"extra":"\\ud800"')).status).toBe('pending');
    expect(readRaw(metaJson('"extra":1e400')).status).toBe('pending');
    const trailing = metaJson('"extra":[1,]');
    expect(rejectRaw(trailing)).toThrow(`Invalid PROPOSAL.json: expected value at line 1 column ${trailing.indexOf(',]') + 2}`);
    const badEscape = metaJson('"extra":"\\uZZ00"');
    expect(rejectRaw(badEscape)).toThrow(/Invalid PROPOSAL\.json: invalid escape at line 1 column/);
    expect(updateWithMarker(
      `{"sourceKind":"a","proposalId":"p","contentSha256":"c","installedAt":"t","sessionId":"s","packageVersion":41,"x":${deep}}`,
    )).toBe(42);
  });
});
