import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { POST_WRITE_TRUST_NEXT_STEP } from '../src/tools/skill-install-executor.ts';
import {
  APPLY_SUCCESS_MESSAGE, SkillWorkshopExecutor,
} from '../src/tools/skill-workshop-executor.ts';
import {
  MAX_CONTENT_BYTES, SKILL_FILE_NAME, normalizeWorkshopSha256, sha256Hex,
  validateContent, validatePackageFiles, workshopRisk,
} from '../src/tools/skill-workshop-package.ts';
import {
  PROPOSAL_META_FILE, decodeAgentWorkshopMarkerVersion, generateProposalId, proposalRevisionSha256,
  readProposalMeta, readProposalPackage, validateProposalId, validateWorkshopSkillId,
  verifyApprovedProposal, writeProposalFiles, type ProposalMeta,
} from '../src/tools/skill-workshop-proposals.ts';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-workshop-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function reviewedMeta(contentSha256: string): ProposalMeta {
  return {
    proposalId: 'wp_1234567890_abcd',
    action: 'propose_create',
    skillId: 'reviewed-skill',
    contentSha256,
    createdAt: '2026-07-11T00:00:00Z',
    sessionId: 'sess_review',
    status: 'pending',
    files: [],
    previousFiles: [],
    packageVersion: 1,
  };
}

describe('skill_workshop_executor.rs', () => {
  it('validate_skill_id_rejects_invalid_chars', () => {
    expect(() => validateWorkshopSkillId('good-skill_1')).not.toThrow();
    expect(() => validateWorkshopSkillId('../evil')).toThrow();
    expect(() => validateWorkshopSkillId('CON')).toThrow();
    expect(() => validateWorkshopSkillId('LPT1')).toThrow();
    expect(() => validateWorkshopSkillId('')).toThrow();
  });

  it('validate_content_requires_frontmatter_and_size', () => {
    expect(() => validateContent('---\nname: test\n---\n# Body')).not.toThrow();
    expect(() => validateContent('# no frontmatter')).toThrow();
    expect(() => validateContent('---\nname: missing-close')).toThrow();
    expect(() => validateContent('----\nname: invalid\n---')).toThrow();
    expect(() => validateContent(`---\n${'x'.repeat(MAX_CONTENT_BYTES)}`)).toThrow();
  });

  it('validate_proposal_id_rejects_path_injection', () => {
    expect(() => validateProposalId('wp_1234567890_abcd')).not.toThrow();
    expect(() => validateProposalId('../etc/passwd')).toThrow();
    expect(() => validateProposalId('wp_../../x')).toThrow();
  });

  it('generate_proposal_id_matches_expected_pattern', () => {
    const id = generateProposalId();
    expect(id.startsWith('wp_')).toBe(true);
    const parts = id.split('_');
    expect(parts).toHaveLength(3);
    expect(parts[1]!.split('').every(ch => ch >= '0' && ch <= '9')).toBe(true);
    expect(parts[2]).toHaveLength(4);
  });

  it('sha256_hex_is_deterministic', () => {
    const a = sha256Hex(Buffer.from('hello'));
    const b = sha256Hex(Buffer.from('hello'));
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });

  it('approved_proposal_hash_and_revision_reject_post_approval_tampering', () => {
    const reviewedContent = Buffer.from('---\nname: reviewed\n---\nbody');
    const reviewedFiles = [{ path: SKILL_FILE_NAME, bytes: reviewedContent }];
    const reviewedHash = sha256Hex(reviewedContent);
    const meta = reviewedMeta(reviewedHash);
    const reviewedRevision = proposalRevisionSha256(meta);
    expect(() => verifyApprovedProposal(meta, reviewedFiles, reviewedHash, reviewedRevision))
      .not.toThrow();

    const changedBody = Buffer.from('---\nname: reviewed\n---\nmalicious replacement');
    const changedFiles = [{ path: SKILL_FILE_NAME, bytes: changedBody }];
    expect(() => verifyApprovedProposal(meta, changedFiles, reviewedHash, reviewedRevision))
      .toThrow('SKILL.md changed after approval');

    const replaced = { ...meta, contentSha256: sha256Hex(changedBody) };
    expect(() => verifyApprovedProposal(replaced, changedFiles, reviewedHash, reviewedRevision))
      .toThrow('Proposal changed after approval');

    const retargeted = { ...meta, skillId: 'different-target' };
    expect(() => verifyApprovedProposal(retargeted, reviewedFiles, reviewedHash, reviewedRevision))
      .toThrow('Proposal changed after approval');
  });

  it('approval_hash_fields_require_full_sha256', () => {
    expect(() => normalizeWorkshopSha256('abc', 'expected')).toThrow();
    expect(() => normalizeWorkshopSha256(
      '0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF',
      'expected',
    )).not.toThrow();
  });

  it('workshop_content_uses_the_package_risk_model', () => {
    const content = Buffer.from(
      '---\nallowed-tools:\n  - local_shell\n  - fetch\n---\nRun curl with an api_key',
    );
    const [riskLevel, signals] = workshopRisk([{ path: SKILL_FILE_NAME, bytes: content }]);
    expect(riskLevel).toBe('high');
    expect(signals).toContain('shell_tools');
    expect(signals).toContain('network_tools');
    expect(signals).toContain('credential_keywords');
  });

  it('write_proposal_files_creates_missing_directories', () => {
    const root = tempDir();
    const dir = path.join(root, 'wp_1234567890_abcd');
    expect(fs.existsSync(dir)).toBe(false);

    const meta = reviewedMeta(sha256Hex(Buffer.from('---\nname: t\n---\nbody')));
    meta.createdAt = new Date().toISOString();
    meta.sessionId = 'sess_test';
    meta.skillId = 'test-skill';
    const result = writeProposalFiles(dir, [{
      path: SKILL_FILE_NAME,
      bytes: Buffer.from('---\nname: t\n---\nbody'),
    }], meta);
    expect(result).toBeUndefined();
    expect(fs.existsSync(path.join(dir, SKILL_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, PROPOSAL_META_FILE))).toBe(true);

    const readBack = readProposalMeta(dir);
    expect(readBack.proposalId).toBe('wp_1234567890_abcd');
    expect(readBack.status).toBe('pending');
  });

  it('X6-unchecked-decode proposal meta decodes like serde ProposalMeta', () => {
    const dir = tempDir();
    const write = (value: unknown) => fs.writeFileSync(path.join(dir, PROPOSAL_META_FILE), JSON.stringify(value));
    const base = {
      proposalId: 'wp_1_a', action: 'propose_update', skillId: 's', contentSha256: 'c',
      createdAt: 't', sessionId: 'sess', status: 'pending',
    };
    write({ ...base, previousSha256: null, extra: 1 });
    const decoded = readProposalMeta(dir);
    expect(decoded.previousSha256).toBeUndefined();
    expect(decoded.files).toEqual([]);
    expect(decoded.packageVersion).toBe(1);

    const { status: _status, ...missing } = base;
    write(missing);
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: missing field \`status\``);
    write({ ...base, status: 7 });
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: invalid type: integer \`7\`, expected a string`);
    write({ ...base, files: [{ path: 'SKILL.md', sha256: 'x' }] });
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: missing field \`size\``);
    write({ ...base, files: null });
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: invalid type: null, expected a sequence`);
    write({ ...base, packageVersion: 1.5 });
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: invalid type: floating point \`1.5\`, expected u64`);
    write(['not', 'a', 'map']);
    // serde derive visit_seq: the sequence form is accepted; element 3 (contentSha256) is missing.
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: invalid length 3, expected struct ProposalMeta with 13 elements at line 1 column 17`);
    write(7);
    expect(() => readProposalMeta(dir)).toThrow(`Invalid ${PROPOSAL_META_FILE}: invalid type: integer \`7\`, expected struct ProposalMeta at line 1 column 1`);
  });

  it('X6-unchecked-decode marker version requires a full AgentWorkshopMarker', () => {
    const marker = {
      sourceKind: 'agent_workshop', proposalId: 'wp_1_a', contentSha256: 'c',
      installedAt: 't', sessionId: 'sess', packageVersion: 4,
    };
    expect(decodeAgentWorkshopMarkerVersion(marker)).toBe(4);
    const { packageVersion: _v, ...noVersion } = marker;
    expect(decodeAgentWorkshopMarkerVersion(noVersion)).toBe(1);
    const { installedAt: _i, ...missing } = marker;
    expect(() => decodeAgentWorkshopMarkerVersion(missing)).toThrow('missing field `installedAt`');
    expect(() => decodeAgentWorkshopMarkerVersion({ ...marker, packageVersion: -1 })).toThrow('expected u64');
  });

  it('package_validation_accepts_resources_and_rejects_path_attacks', () => {
    const body = Buffer.from('---\nname: t\n---\nbody');
    const valid = [
      { path: SKILL_FILE_NAME, bytes: body },
      { path: 'scripts/run.sh', bytes: Buffer.from('echo ok') },
      { path: 'references/guide.md', bytes: Buffer.from('guide') },
      { path: 'assets/icon.bin', bytes: Buffer.from([0, 1, 2]) },
      { path: 'agents/openai.yaml', bytes: Buffer.from('interface: {}') },
      { path: 'templates/report.md', bytes: Buffer.from('template') },
      { path: 'examples/sample.md', bytes: Buffer.from('example') },
      { path: 'README.md', bytes: Buffer.from('readme') },
      { path: 'README.en.md', bytes: Buffer.from('english readme') },
      { path: 'LICENSE.txt', bytes: Buffer.from('license') },
      { path: '_meta.json', bytes: Buffer.from('{}') },
      { path: 'skill-card.md', bytes: Buffer.from('card') },
    ];
    expect(() => validatePackageFiles(valid)).not.toThrow();
    for (const attacked of ['/tmp/x', '../x', 'scripts/../x', 'other/file.txt', 'scripts\\x']) {
      const files = [
        { path: SKILL_FILE_NAME, bytes: body },
        { path: attacked, bytes: Buffer.from('x') },
      ];
      expect(() => validatePackageFiles(files), `accepted ${attacked}`).toThrow();
    }
  });

  it('package_validation_rejects_case_folded_duplicates', () => {
    const files = [
      { path: SKILL_FILE_NAME, bytes: Buffer.from('---\nname: t\n---\nbody') },
      { path: 'scripts/Run.sh', bytes: Buffer.from('one') },
      { path: 'scripts/run.sh', bytes: Buffer.from('two') },
    ];
    expect(() => validatePackageFiles(files)).toThrow();
  });

  it('proposal_reader_rejects_symlink_substitution', () => {
    const root = tempDir();
    fs.mkdirSync(path.join(root, 'scripts'));
    const body = Buffer.from('---\nname: t\n---\nbody');
    fs.writeFileSync(path.join(root, SKILL_FILE_NAME), body);
    fs.symlinkSync(path.join(root, SKILL_FILE_NAME), path.join(root, 'scripts/run.sh'));
    const meta = reviewedMeta(sha256Hex(body));
    meta.files = [
      { path: SKILL_FILE_NAME, sha256: sha256Hex(body), size: body.length },
      { path: 'scripts/run.sh', sha256: '0'.repeat(64), size: 1 },
    ];
    expect(() => readProposalPackage(root, meta)).toThrow();
  });

  it('apply_success_narrative_routes_through_skill_trust_request', () => {
    expect(APPLY_SUCCESS_MESSAGE).toContain('skill_trust_request');
    expect(APPLY_SUCCESS_MESSAGE).toContain('Do not load_skills until trust is granted');
    expect(APPLY_SUCCESS_MESSAGE).toContain('Skills management is only a backup');
    expect(APPLY_SUCCESS_MESSAGE).not.toContain('user must trust it in Skills management');
    expect(APPLY_SUCCESS_MESSAGE).not.toContain('On the next turn you may load_skills');

    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('action=inspect');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('action=grant');
    expect(POST_WRITE_TRUST_NEXT_STEP).toContain('Skills management UI is only a backup');
  });

  it('classifies both workshop tools and apply sensitivity', () => {
    const executor = new SkillWorkshopExecutor({
      proposalsRoot: '/tmp/proposals', skillsBase: '/tmp/skills', sessionId: 's',
    });
    expect(executor.canHandle('skill_workshop_propose')).toBe(true);
    expect(executor.canHandle('builtin-skill_workshop_apply')).toBe(true);
    expect(executor.canHandle('skill_install')).toBe(false);
    expect(executor.sensitivityLevel('skill_workshop_propose')).toBe('medium');
    expect(executor.sensitivityLevel('builtin-skill_workshop_apply')).toBe('high');
    expect(executor.name()).toBe('SkillWorkshopExecutor');
  });
});
