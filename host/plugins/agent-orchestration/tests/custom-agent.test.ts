import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  atomicWrite, canHandleCustomAgentTool, CustomAgentStore, customAgentSensitivityLevel,
  firstHeading, generateProposalId, proposalRevisionSha256, resolvePersonaPath, sha256Hex,
  validatePersonaContent, validatePersonaFileName, validateProposalId,
  type PersonaProposalMeta,
} from '../src/custom-agent.ts';
import { setLocalNodeRuntime } from '../src/local-node-runtime.ts';
import { nodeLocalNodeRuntime } from '../src/local-node-runtime.node.ts';

// 人设文件走同步端口；单元测试直接装同一份 `node:fs` 实现（桌面入口注入）。
beforeAll(() => { setLocalNodeRuntime(nodeLocalNodeRuntime); });
afterAll(() => { setLocalNodeRuntime(null); });

const VALID_PERSONA = '---\nname: paper-summarizer\ndescription: 论文摘要\nbase: explorer\n---\n# 论文摘要员\n正文。\n';

const tempDirs: string[] = [];

function makeStore(): { root: string; store: CustomAgentStore } {
  const root = mkdtempSync(join(tmpdir(), 'l06-persona-'));
  tempDirs.push(root);
  const store = new CustomAgentStore({
    agentsDir: join(root, 'agents'),
    pendingDir: join(root, 'agents-pending'),
  });
  mkdirSync(store.agentsDir, { recursive: true });
  return { root, store };
}

function proposalMeta(overrides: Partial<PersonaProposalMeta> = {}): PersonaProposalMeta {
  return {
    proposalId: generateProposalId(),
    action: 'create',
    fileName: 'paper-summarizer.md',
    agentName: 'paper-summarizer',
    contentSha256: sha256Hex(VALID_PERSONA),
    previousSha256: null,
    createdAt: new Date().toISOString(),
    sessionId: 'sess_test',
    status: 'pending',
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('custom_agent_executor.rs persona validation', () => {
  it('file_name_validation_rejects_traversal_and_bad_charsets', () => {
    expect(validatePersonaFileName('paper-summarizer.md')).toBe('paper-summarizer.md');
    expect(validatePersonaFileName('a1-b2.md')).toBe('a1-b2.md');
    for (const bad of ['', 'noext', 'Upper.md', 'has space.md', 'under_score.md',
      '../evil.md', 'a/b.md', 'a\\b.md', '.md', 'con.md', 'x.MD']) {
      expect(() => validatePersonaFileName(bad), bad).toThrow();
    }
  });

  it('resolve_persona_path_stays_within_base_and_rejects_symlinks', () => {
    const { root, store } = makeStore();
    const resolved = resolvePersonaPath(store.agentsDir, 'ok-agent.md');
    expect(dirname(resolved)).toBe(store.agentsDir);

    writeFileSync(join(root, 'outside.md'), 'x');
    symlinkSync(join(root, 'outside.md'), join(store.agentsDir, 'link-agent.md'));
    expect(() => resolvePersonaPath(store.agentsDir, 'link-agent.md')).toThrow();
  });

  it('content_validation_enforces_frontmatter_name_and_size', () => {
    expect(validatePersonaContent(VALID_PERSONA)).toEqual({
      name: 'paper-summarizer', description: '论文摘要', model: null,
    });
    expect(() => validatePersonaContent('# no frontmatter')).toThrow();
    expect(() => validatePersonaContent('---\nname: x')).toThrow();
    expect(() => validatePersonaContent('---\nbase: worker\n---\nBody')).toThrow();
    expect(() => validatePersonaContent('---\nname: Upper-Case\n---\nBody')).toThrow();
    expect(() => validatePersonaContent('---\nname: worker\n---\nBody')).toThrow();
    expect(() => validatePersonaContent('---\nname: ok-agent\nbase: not-a-builtin\n---\nBody')).toThrow();
    const huge = `---\nname: big-agent\n---\n${'x'.repeat(64 * 1024)}`;
    expect(() => validatePersonaContent(huge)).toThrow();

    for (const unsupported of [
      '---\nname: unsafe-agent\npermissions: workspace-write\n---\nBody',
      '---\nname: unsafe-agent\ncontext_inheritance: full\n---\nBody',
      '---\nname: unsafe-agent\nreasoning_effort: unlimited\n---\nBody',
    ]) {
      expect(() => validatePersonaContent(unsupported), unsupported).toThrow();
    }

    const model = validatePersonaContent(
      '---\nname: exact-model\nmodel: local-config-id\nreasoning_effort: high\n---\nBody',
    );
    expect(model.model).toBe('local-config-id');
  });

  it('proposal_id_validation_rejects_path_injection', () => {
    expect(() => validateProposalId('cap_1234567890_abcd')).not.toThrow();
    expect(() => validateProposalId('../etc')).toThrow();
    expect(() => validateProposalId('cap_../../x')).toThrow();
    expect(() => validateProposalId('wp_1234_abcd')).toThrow();
    expect(() => validateProposalId(generateProposalId())).not.toThrow();
  });

  it('proposal_revision_detects_tampering', () => {
    const meta = proposalMeta();
    const revision = proposalRevisionSha256(meta);
    expect(proposalRevisionSha256({ ...meta, fileName: 'other-agent.md' })).not.toBe(revision);
    expect(proposalRevisionSha256({ ...meta, contentSha256: sha256Hex('malicious') })).not.toBe(revision);
  });

  it('propose_then_apply_writes_persona_and_blocks_replay', async () => {
    const { store } = makeStore();
    const meta = proposalMeta();
    CustomAgentStore.writeProposal(join(store.pendingDir, meta.proposalId), meta, VALID_PERSONA);
    const revision = proposalRevisionSha256(meta);
    const applyArgs = {
      proposal_id: meta.proposalId,
      file_name: 'paper-summarizer.md',
      expected_content_sha256: meta.contentSha256,
      expected_proposal_revision: revision,
    };

    const output = await store.executeApply(applyArgs);
    expect(output.applied).toBe(true);
    const target = join(store.agentsDir, 'paper-summarizer.md');
    expect(readFileSync(target, 'utf8')).toBe(VALID_PERSONA);

    await expect(store.executeApply(applyArgs)).rejects.toThrow();

    const removed = await store.executeRemove({
      file_name: 'paper-summarizer.md',
      expected_content_sha256: sha256Hex(VALID_PERSONA),
    });
    expect(removed.removed).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  describe('X6-UD-L06-custom-agent-217 PROPOSAL.json serde decoding (custom_agent_executor.rs:64-81, 439-451)', () => {
    function applyWithMeta(encode: (meta: Record<string, unknown>) => string | null | undefined) {
      const { store } = makeStore();
      const meta = proposalMeta();
      const dir = join(store.pendingDir, meta.proposalId);
      CustomAgentStore.writeProposal(dir, meta, VALID_PERSONA);
      const raw = encode({ ...meta });
      if (raw === null) rmSync(join(dir, 'PROPOSAL.json'));
      else if (raw !== undefined) writeFileSync(join(dir, 'PROPOSAL.json'), raw);
      const args = {
        proposal_id: meta.proposalId, file_name: meta.fileName,
        expected_content_sha256: meta.contentSha256, expected_proposal_revision: proposalRevisionSha256(meta),
      };
      return { store, meta, dir, run: () => store.executeApply(args) };
    }

    it('writes fields in declaration order and omits a None previousSha256', () => {
      const { dir } = applyWithMeta(() => undefined);
      const written = JSON.parse(readFileSync(join(dir, 'PROPOSAL.json'), 'utf8')) as Record<string, unknown>;
      expect(Object.keys(written)).toEqual(['proposalId', 'action', 'fileName', 'agentName', 'contentSha256',
        'createdAt', 'sessionId', 'status']);
    });

    it('ignores unknown fields and accepts a missing or null previousSha256', async () => {
      expect((await applyWithMeta((m) => { delete m.previousSha256; return JSON.stringify({ ...m, extra: 1 }); })
        .run()).applied).toBe(true);
      expect((await applyWithMeta((m) => JSON.stringify({ ...m, previousSha256: null })).run()).applied).toBe(true);
    });

    it.each([
      ['missing required field', (m: Record<string, unknown>) => { delete m.status; }, 'missing field `status`'],
      ['missing fields in declaration order', (m: Record<string, unknown>) => { delete m.status; delete m.proposalId; },
        'missing field `proposalId`'],
      ['non-string field', (m: Record<string, unknown>) => { m.action = 1; }, 'invalid type: integer `1`, expected a string'],
      ['null required string', (m: Record<string, unknown>) => { m.fileName = null; }, 'invalid type: null, expected a string'],
      ['non-string previousSha256', (m: Record<string, unknown>) => { m.previousSha256 = false; },
        'invalid type: boolean `false`, expected a string'],
    ])('rejects %s with the Rust "Invalid PROPOSAL.json" context', async (_label, mutate, serde) => {
      await expect(applyWithMeta((m) => { mutate(m); return JSON.stringify(m); }).run()).rejects.toThrow(`Invalid PROPOSAL.json: ${serde}`);
    });

    it('rejects a short positional struct, as the Rust derived SeqAccess does', async () => {
      await expect(applyWithMeta(() => '[]').run())
        .rejects.toThrow('Invalid PROPOSAL.json: invalid length 0, expected struct PersonaProposalMeta with 9 elements at line 1 column 2');
    });

    it('X6-UD-0002 accepts the full positional struct, preserving field order and Option slots', async () => {
      expect((await applyWithMeta((m) => JSON.stringify([
        m.proposalId, m.action, m.fileName, m.agentName, m.contentSha256,
        null, m.createdAt, m.sessionId, m.status,
      ])).run()).applied).toBe(true);
    });

    it.each([
      ['{"proposalId":"a","proposalId":',
        'duplicate field `proposalId` at line 1 column 30'],
      ['{"previousSha256":null,"previousSha256":',
        'duplicate field `previousSha256` at line 1 column 39'],
      ['{"action":7,"proposalId":',
        'invalid type: integer `7`, expected a string at line 1 column 11'],
      ['{"action":1.0}',
        'invalid type: floating point `1.0`, expected a string at line 1 column 13'],
      ['{"action":9007199254740993}',
        'invalid type: integer `9007199254740993`, expected a string at line 1 column 26'],
      ['{\n"unknown":"步骤","action":false}',
        'invalid type: boolean `false`, expected a string at line 2 column 33'],
      ['{"unknown":]', 'expected value at line 1 column 12'],
      ['{} trailing', 'missing field `proposalId` at line 1 column 2'],
    ])('X6-UD-0002 preserves typed error order and exact byte positions for %s', async (raw, reason) => {
      await expect(applyWithMeta(() => raw).run()).rejects.toThrow(`Invalid PROPOSAL.json: ${reason}`);
    });

    it('X6-UD-0002 rejects duplicate fields in otherwise valid metadata before any file is applied', async () => {
      const { store, dir, run } = applyWithMeta((m) =>
        JSON.stringify(m).slice(0, -1) + ',"fileName":"other-agent.md"}');
      await expect(run()).rejects.toThrow('Invalid PROPOSAL.json: duplicate field `fileName`');
      expect(existsSync(join(store.agentsDir, 'paper-summarizer.md'))).toBe(false);
      expect(existsSync(join(store.agentsDir, 'other-agent.md'))).toBe(false);
      expect(existsSync(join(dir, 'persona.md'))).toBe(true);
    });

    it('X6-UD-0002 ignores repeated unknown fields but rejects trailing data after a valid struct', async () => {
      expect((await applyWithMeta((m) => JSON.stringify(m).slice(0, -1)
        + ',"extra":{"a":1},"extra":[2]}').run()).applied).toBe(true);
      await expect(applyWithMeta((m) => JSON.stringify(m) + ' trailing').run())
        .rejects.toThrow('Invalid PROPOSAL.json: trailing characters at line 1 column');
    });

    it('X6-UD-0002 treats action/status as Rust String fields, not enums', () => {
      const { store } = applyWithMeta((m) => JSON.stringify({ ...m, action: 'future-action' }));
      expect(store.countPendingProposals()).toBe(1);
    });

    it('X6-UD-0002 IgnoredAny: unknown 1e400 is ignored without f64 conversion', async () => {
      const { store, run } = applyWithMeta((m) => JSON.stringify(m).slice(0, -1) + ',"extra":1e400}');
      expect((await run()).applied).toBe(true);
      expect(readFileSync(join(store.agentsDir, 'paper-summarizer.md'), 'utf8')).toBe(VALID_PERSONA);
    });

    it('X6-UD-0002 endArray: excess positional fields use peek_error location', async () => {
      let expectedColumn = 0;
      const { store, dir, run } = applyWithMeta((m) => {
        const raw = JSON.stringify([m.proposalId, m.action, m.fileName, m.agentName, m.contentSha256,
          null, m.createdAt, m.sessionId, m.status]).slice(0, -1) + ', "extra"]';
        expectedColumn = Buffer.byteLength(raw.slice(0, raw.lastIndexOf('"extra"'))) + 1;
        return raw;
      });
      await expect(run()).rejects.toThrow(`Invalid PROPOSAL.json: trailing characters at line 1 column ${expectedColumn}`);
      expect(existsSync(join(store.agentsDir, 'paper-summarizer.md'))).toBe(false);
      expect(existsSync(join(dir, 'persona.md'))).toBe(true);
    });

    it('reports a missing file with the Rust read context', async () => {
      await expect(applyWithMeta(() => null).run()).rejects.toThrow('Failed to read PROPOSAL.json: No such file or directory (os error 2)');
    });

    it('count_pending_proposals skips malformed metadata', () => {
      const { store } = applyWithMeta(() => JSON.stringify({ proposalId: 'x' }));
      expect(store.countPendingProposals()).toBe(0);
    });
  });

  it('apply_rejects_target_drift_toctou', async () => {
    const { store } = makeStore();
    const meta = proposalMeta({
      fileName: 'drift-agent.md', agentName: 'drift-agent',
      contentSha256: sha256Hex(VALID_PERSONA),
    });
    CustomAgentStore.writeProposal(join(store.pendingDir, meta.proposalId), meta, VALID_PERSONA);
    const revision = proposalRevisionSha256(meta);
    writeFileSync(join(store.agentsDir, 'drift-agent.md'), '---\nname: drift-agent\n---\nManual');

    let message = '';
    try {
      await store.executeApply({
        proposal_id: meta.proposalId,
        file_name: 'drift-agent.md',
        expected_content_sha256: meta.contentSha256,
        expected_proposal_revision: revision,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('created after this proposal');
  });

  it('sensitivity_mapping_matches_governance_contract', () => {
    expect(customAgentSensitivityLevel('builtin-custom_agent_list')).toBe('Low');
    expect(customAgentSensitivityLevel('builtin-custom_agent_get')).toBe('Low');
    expect(customAgentSensitivityLevel('builtin-custom_agent_propose')).toBe('Medium');
    expect(customAgentSensitivityLevel('builtin-custom_agent_apply')).toBe('High');
    expect(customAgentSensitivityLevel('builtin-custom_agent_remove')).toBe('High');
    for (const name of ['custom_agent_list', 'builtin-custom_agent_get', 'custom_agent_propose',
      'builtin-custom_agent_apply', 'custom_agent_remove']) {
      expect(canHandleCustomAgentTool(name), name).toBe(true);
    }
    expect(canHandleCustomAgentTool('subagent_call')).toBe(false);
  });

  it('atomic_write_replaces_existing_file_and_first_heading_skips_frontmatter', () => {
    const { root } = makeStore();
    const target = join(root, 'out.md');
    atomicWrite(target, Buffer.from('one', 'utf8'));
    atomicWrite(target, Buffer.from('two', 'utf8'));
    expect(readFileSync(target, 'utf8')).toBe('two');
    expect(firstHeading('---\nname: x\n---\n\n# Title\nbody')).toBe('# Title');
    expect(firstHeading('no frontmatter')).toBeNull();
  });
});
