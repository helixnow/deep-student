import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REGISTRY_DIR, checkRustFixes } from './rust-fixes.mjs';

const SCRIPT = path.resolve(__dirname, 'rust-fixes.mjs');
const ID = 'RF-W02-loaded-skill-ids-truncation';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function repo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), 'w09-rust-fixes-'));
  roots.push(root);
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    writeFileSync(path.join(root, f), t);
  }
  return root;
}
const cli = (root: string, ...args: string[]) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, '--root', root, ...args], { encoding: 'utf8' }) };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, out: err.stdout };
  }
};

type Entry = Record<string, unknown>;
const entry = (over: Entry = {}): Entry => ({
  id: ID,
  kind: 'rust-bug',
  status: 'proposed',
  title: 'loaded_skill_ids parsed from a truncated tool result',
  rust: { file: 'src-tauri/src/chat/skills.rs', line: 123, behavior: 'parses ids from the truncated preview' },
  fix: { files: ['host/plugins/chat/src/skills.ts'], behavior: 'parses ids from the full result' },
  evidence: 'ids after the truncation point are lost; Rust comment says all loaded ids are recorded',
  g3: { affects: true, selectors: [{ scenario: 'chat.stream.*', surface: 'db', table: 'chat_v2_messages', column: 'meta_json', jsonPath: '$.loaded_skill_ids' }] },
  tests: [{ file: 'host/plugins/chat/tests/skills.test.ts', name: `${ID}: keeps ids past the preview limit` }],
  ...over,
});
const tree = (e: Entry | null, extra: Record<string, string> = {}) => ({
  'src-tauri/src/chat/skills.rs': '// rust\n',
  'host/plugins/chat/src/skills.ts': `export const a = 1;\n// RUST-FIX(${ID}): Rust parsed ids from the truncated preview\n`,
  'host/plugins/chat/tests/skills.test.ts': `it('${ID}: keeps ids past the preview limit', () => {});\n`,
  ...(e ? { [`${REGISTRY_DIR}/${String(e.id)}.json`]: JSON.stringify(e, null, 2) } : {}),
  ...extra,
});
const problems = (root: string) => checkRustFixes(root).findings.map((f: { rule: string; file: string; line: number; message: string }) => `${f.rule} ${f.file}:${f.line} ${f.message}`);

describe('rust-fixes gate: passing registries', () => {
  it('passes when the registry directory is missing or empty', () => {
    expect(cli(repo({ 'host/a.ts': 'export {};\n' }), '--check').code).toBe(0);
    const empty = repo({ [`${REGISTRY_DIR}/.keep`]: '' });
    expect(cli(empty, '--check')).toMatchObject({ code: 0 });
  });

  it('accepts a proposed entry, an approved entry and a fix without G3 effect', () => {
    const second = 'RF-W04-ocr-page-order';
    const root = repo(tree(entry(), {
      [`${REGISTRY_DIR}/${second}.json`]: JSON.stringify(entry({
        id: second, kind: 'deliberate', status: 'approved', approvedBy: 'main', approvedAt: '2026-11-07T08:30:00+08:00',
        userVisible: 'OCR 结果按页码顺序显示', dataCompat: '不改变落库数据',
        fix: { files: ['host/plugins/media/ocr.ts'], behavior: 'pages keep source order' },
        g3: { affects: false, selectors: [] },
        tests: [{ file: 'host/plugins/media/ocr.test.ts', name: `${second} keeps order` }],
      })),
      'host/plugins/media/ocr.ts': `/* RUST-FIX(${second}): Rust sorted pages lexically */\n`,
      'host/plugins/media/ocr.test.ts': `describe.skipIf(false)("${second} keeps order", () => {});\n`,
    }));
    expect(problems(root)).toEqual([]);
    const out = cli(root, '--check');
    expect(out.code).toBe(0);
    expect(out.out).toContain('2 entries (proposed 1, approved 1), 2 RUST-FIX markers, 0 errors');
  });

  it('accepts narrow selectors for every surface, including scenario * with a precise db column', () => {
    const root = repo(tree(entry({
      g3: {
        affects: true,
        selectors: [
          { scenario: '*', surface: 'db', table: 'chat_v2_messages', column: 'meta_json' },
          { scenario: '*', surface: 'db', table: 'chat_v2_messages', column: 'meta_*', jsonPath: '$.x' },
          { scenario: 'chat.*', surface: 'event', event: 'chat_v2_event', jsonPath: '$.payload.ids' },
          { scenario: 'notes.*', surface: 'ipc', command: 'notes_get' },
          { scenario: 'backup.*', surface: 'fs', path: 'backups/*.zip' },
        ],
      },
    })));
    expect(problems(root)).toEqual([]);
  });
});

describe('rust-fixes gate: negative examples', () => {
  const file = `${REGISTRY_DIR}/${ID}.json`;

  it('rejects malformed JSON, missing fields, bad enums and approved without approver', () => {
    expect(problems(repo(tree(null, { [file]: '{ "id": ' })))).toEqual([
      expect.stringMatching(new RegExp(`^schema ${file}:1 不是合法 JSON`)),
      `marker host/plugins/chat/src/skills.ts:2 孤立的 RUST-FIX(${ID}) 标记：${REGISTRY_DIR}/ 里没有这个登记`,
    ]);

    const { evidence: _evidence, ...noEvidence } = entry();
    expect(problems(repo(tree(noEvidence)))).toContain(`schema ${file}:1 / 缺少 evidence`);

    const bad = problems(repo(tree(entry({ kind: 'bug', status: 'done', extra: 1 }))));
    expect(bad).toContain(`schema ${file}:1 /kind 只能是 rust-bug / deliberate`);
    expect(bad).toContain(`schema ${file}:1 /status 只能是 proposed / approved`);
    expect(bad).toContain(`schema ${file}:1 / 不认识的字段 extra`);

    const approved = problems(repo(tree(entry({ status: 'approved' }))));
    expect(approved).toEqual([`schema ${file}:1 / 缺少 approvedBy`, `schema ${file}:1 / 缺少 approvedAt`]);
  });

  it('deliberate entries must state userVisible and dataCompat; rust-bug entries may', () => {
    expect(problems(repo(tree(entry({ kind: 'deliberate' }))))).toEqual([`schema ${file}:1 / 缺少 userVisible`, `schema ${file}:1 / 缺少 dataCompat`]);
    expect(problems(repo(tree(entry({ kind: 'deliberate', userVisible: '否', dataCompat: '' }))))).toEqual([`schema ${file}:1 /dataCompat must NOT have fewer than 1 characters`]);
    expect(problems(repo(tree(entry({ kind: 'deliberate', userVisible: '否', dataCompat: '不改变落库数据' }))))).toEqual([]);
    expect(problems(repo(tree(entry({ userVisible: '长译文可以分页查看' }))))).toEqual([]);
  });

  it('rejects an id that does not match its file name, and duplicate ids', () => {
    const root = repo(tree(entry(), { [`${REGISTRY_DIR}/RF-W02-copy.json`]: JSON.stringify(entry()) }));
    expect(problems(root)).toEqual([
      `id ${REGISTRY_DIR}/RF-W02-copy.json:1 id ${ID} 与文件名不一致（应为 ${ID}.json）`,
      `id ${file}:1 id ${ID} 重复（另见 ${REGISTRY_DIR}/RF-W02-copy.json）`,
    ]);
    expect(problems(repo(tree(entry({ id: 'rf-lowercase' }))))).toContain(`schema ${REGISTRY_DIR}/rf-lowercase.json:1 /id must match pattern "^RF-[A-Z][A-Z0-9]*-[a-z0-9]+(?:-[a-z0-9]+)*$"`);
  });

  it('markers and registrations correspond one to one', () => {
    const orphan = repo(tree(entry(), { 'src/features/x.ts': '\n// RUST-FIX(RF-W09-unregistered): nope\n' }));
    expect(problems(orphan)).toEqual([`marker src/features/x.ts:2 孤立的 RUST-FIX(RF-W09-unregistered) 标记：${REGISTRY_DIR}/ 里没有这个登记`]);

    const unlisted = repo(tree(entry(), { 'electron/main.ts': `// RUST-FIX(${ID}): also here\n` }));
    expect(problems(unlisted)).toEqual([`marker electron/main.ts:1 RUST-FIX(${ID}) 所在文件没有列在 ${file} 的 fix.files 里`]);

    const unmarked = repo(tree(entry(), { 'host/plugins/chat/src/skills.ts': 'export const a = 1;\n' }));
    expect(problems(unmarked)).toEqual([`marker ${file}:1 fix.files 中的 host/plugins/chat/src/skills.ts 没有 RUST-FIX(${ID}) 标记`]);

    const missing = repo(tree(entry({ fix: { files: ['host/plugins/chat/src/skills.ts', 'host/gone.ts'], behavior: 'x' } })));
    expect(problems(missing)).toEqual([`marker ${file}:1 fix.files 中的 host/gone.ts 不存在`]);
  });

  it('tests must exist and carry a title starting with the id; rust.file must exist', () => {
    const noFile = repo(tree(entry({ tests: [{ file: 'host/plugins/chat/tests/none.test.ts', name: `${ID}: x` }] })));
    expect(problems(noFile)).toEqual([`test ${file}:1 测试文件 host/plugins/chat/tests/none.test.ts 不存在`]);

    const eachTitle = repo(tree(entry(), { 'host/plugins/chat/tests/skills.test.ts': `it.each([[1, 2]])(\n  '${ID}: keeps %s', () => {});\n` }));
    expect(problems(eachTitle)).toEqual([]);

    const noTitle = repo(tree(entry(), { 'host/plugins/chat/tests/skills.test.ts': `it('keeps ids (${ID})', () => {});\n` }));
    expect(problems(noTitle)).toEqual([`test ${file}:1 测试文件 host/plugins/chat/tests/skills.test.ts 里没有以 ${ID} 开头的测试标题`]);

    const titled = (body: string) => problems(repo(tree(entry(), { 'host/plugins/chat/tests/skills.test.ts': body })));
    const missing = [`test ${file}:1 测试文件 host/plugins/chat/tests/skills.test.ts 里没有以 ${ID} 开头的测试标题`];
    for (const body of [
      `const ID = '${ID}';\nit(\`\${ID}: keeps ids\`, () => {});\n`,
      `const ID = "${ID}" as const;\ndescribe(\`\${ ID } keeps ids\`, () => {});\n`,
      `const RF_ID = '${ID}'\ntest.skipIf(false)(\`\${RF_ID}: x\`, () => {});\n`,
      `it(\`${ID}: literal template\`, () => {});\n`,
    ]) expect(titled(body), body).toEqual([]);
    for (const body of [
      `let ID = '${ID}';\nit(\`\${ID}: x\`, () => {});\n`,
      `var ID = '${ID}';\nit(\`\${ID}: x\`, () => {});\n`,
      `const ID = 'RF-W02-other';\nit(\`\${ID}: x\`, () => {});\n`,
      `const ID = '${ID}-extra';\nit(\`\${ID}: x\`, () => {});\n`,
      `const ID = 'RF-W02-' + 'loaded-skill-ids-truncation';\nit(\`\${ID}: x\`, () => {});\n`,
      `import { ID } from './ids';\nit(\`\${ID}: x\`, () => {});\n`,
      `const RF = { id: '${ID}' };\nit(\`\${RF.id}: x\`, () => {});\n`,
      `const ID = '${ID}';\nit(\`x \${ID}\`, () => {});\n`,
      `const ID = '${ID}';\nit(ID + ': x', () => {});\n`,
      `const ID = '${ID}';\nconst OTHER = 'x';\nit(\`\${OTHER}\${ID}\`, () => {});\n`,
    ]) expect(titled(body), body).toEqual(missing);

    const badName = repo(tree(entry({ tests: [{ file: 'host/plugins/chat/tests/skills.test.ts', name: 'keeps ids' }] })));
    expect(problems(badName)).toEqual([`test ${file}:1 tests[].name 必须以 ${ID} 开头：keeps ids`]);

    const noRust = repo(tree(entry({ rust: { file: 'src-tauri/src/gone.rs', behavior: 'x' } })));
    expect(problems(noRust)).toEqual([`rust ${file}:1 rust.file src-tauri/src/gone.rs 不存在`]);

    const rustEraFrontend = repo(tree(entry({ rust: { file: 'src/chat/Viewer.tsx', behavior: 'x' } }), { 'src/chat/Viewer.tsx': '' }));
    expect(problems(rustEraFrontend)).toEqual([]);
    const elsewhere = repo(tree(entry({ rust: { file: 'host/plugins/chat/skills.ts', behavior: 'x' } }), { 'host/plugins/chat/skills.ts': '' }));
    expect(problems(elsewhere)).toEqual([`schema ${file}:1 /rust/file must match pattern "^(?:src-tauri|src)/"`]);
  });

  it('rejects over-broad selectors', () => {
    const g3 = (...selectors: Entry[]) => problems(repo(tree(entry({ g3: { affects: true, selectors } }))));
    expect(g3({ scenario: 'chat.*', surface: 'db', table: 'chat_v2_messages' })).toContain(`schema ${file}:1 /g3/selectors/0 缺少 column`);
    expect(g3({ scenario: 'chat.*', surface: 'db', column: 'meta_json' })).toContain(`schema ${file}:1 /g3/selectors/0 缺少 table`);
    expect(g3({ scenario: 'chat.*', surface: 'event' })).toContain(`schema ${file}:1 /g3/selectors/0 缺少 event`);
    expect(g3({ scenario: 'chat.*', surface: 'ipc' })).toContain(`schema ${file}:1 /g3/selectors/0 缺少 command`);
    expect(g3({ scenario: 'chat.*', surface: 'fs' })).toContain(`schema ${file}:1 /g3/selectors/0 缺少 path`);
    expect(g3({ scenario: 'chat.*', surface: 'event', event: '*' })).toContain(`schema ${file}:1 /g3/selectors/0/event 不能是通配 *（选择器过宽）`);
    expect(g3({ scenario: 'chat.*', surface: 'db', table: '*', column: 'id' })).toContain(`schema ${file}:1 /g3/selectors/0/table 不能是通配 *（选择器过宽）`);
    expect(g3({ scenario: '*', surface: 'db', table: 'chat_v2_messages', column: '*' }))
      .toContain(`schema ${file}:1 /g3/selectors/0 scenario 为 * 的 db 选择器必须给 jsonPath 或非通配的 column（选择器过宽）`);
    expect(g3({ scenario: 'chat.*', surface: 'ipc', command: 'notes_get', table: 'notes' })).toContain(`schema ${file}:1 /g3/selectors/0 带了与 surface 不符的定位字段`);
    expect(g3({ scenario: 'chat.*', surface: 'db', table: 't', colum: 'typo' })).toContain(`schema ${file}:1 /g3/selectors/0 不认识的字段 colum`);
    expect(g3()).toContain(`schema ${file}:1 /g3/selectors must NOT have fewer than 1 items`);
    expect(problems(repo(tree(entry({ g3: { affects: false, selectors: [{ scenario: 'a', surface: 'ipc', command: 'c' }] } })))))
      .toContain(`schema ${file}:1 /g3/selectors must NOT have more than 0 items`);
  });

  it('commits: optional, hex shas only, each must exist in the repository; --review lists them with the grep hits', () => {
    expect(problems(repo(tree(entry({ commits: [] }))))).toEqual([`schema ${file}:1 /commits must NOT have fewer than 1 items`]);
    expect(problems(repo(tree(entry({ commits: ['HEAD~1'] }))))).toEqual([`schema ${file}:1 /commits/0 must match pattern "^[0-9a-f]{7,40}$"`]);

    const root = repo(tree(entry()));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', '[W02] original implementation without the id');
    const original = git('rev-parse', 'HEAD');
    const write = (over: Entry) => writeFileSync(path.join(root, file), JSON.stringify(entry(over)));
    write({ commits: [original.slice(0, 8)] });
    git('commit', '-qam', `[W02][${ID}] register`);
    const registration = git('rev-parse', '--short=8', 'HEAD');

    expect(problems(root)).toEqual([]);
    write({ commits: [original.slice(0, 8), 'deadbeefdeadbeef'] });
    expect(problems(root)).toEqual([`commit ${file}:1 commits 中的 deadbeefdeadbeef 不是本仓库里存在的提交（或缩写有歧义）`]);

    const out = cli(root, '--review');
    expect(out.out).toContain(`登记提交: ${original.slice(0, 7)}`);
    expect(out.out).toMatch(/登记提交: [0-9a-f]{7,} \S+ \[W02\] original implementation without the id/);
    expect(out.out).toContain('登记提交: deadbeefdeadbeef （本仓库里找不到）');
    expect(out.out).toMatch(new RegExp(`\\n  提交: ${registration.slice(0, 7)}[0-9a-f]* \\S+ \\[W02\\]\\[${ID}\\] register`));

    write({ commits: [registration] });
    const json = JSON.parse(cli(root, '--review', '--json').out);
    expect(json.proposed[0].commits.map((c: { source: string }) => c.source)).toEqual(['registered']);
  });

  it('--review lists proposed entries with the commits that carry their id (read-only)', () => {
    const second = 'RF-W04-ocr-page-order';
    const root = repo(tree(entry(), {
      [`${REGISTRY_DIR}/${second}.json`]: JSON.stringify(entry({
        id: second, kind: 'deliberate', status: 'approved', approvedBy: 'main', approvedAt: '2026-11-07',
        userVisible: '否', dataCompat: '不改变', fix: { files: ['host/plugins/media/ocr.ts'], behavior: 'x' }, g3: { affects: false, selectors: [] },
        tests: [{ file: 'host/plugins/media/ocr.test.ts', name: `${second} x` }],
      })),
      'host/plugins/media/ocr.ts': `// RUST-FIX(${second}): x\n`,
      'host/plugins/media/ocr.test.ts': `it('${second} x', () => {});\n`,
    }));
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('add', '-A');
    git('commit', '-qm', `[W02][${ID}] parse ids from the full result`);
    writeFileSync(path.join(root, 'host/plugins/media/ocr.ts'), `// RUST-FIX(${second}): x\nexport {};\n`);
    git('commit', '-qam', '[W04] unrelated');
    const head = git('rev-parse', 'HEAD');

    const out = cli(root, '--review');
    expect(out.code).toBe(0);
    expect(out.out).toContain('1 proposed, 1 approved, 0 gate errors');
    expect(out.out).toMatch(new RegExp(`${ID} \\[rust-bug\\]`));
    expect(out.out).toMatch(new RegExp(`提交: [0-9a-f]{7,} \\S+ \\[W02\\]\\[${ID}\\] parse ids`));
    expect(out.out).not.toContain('unrelated');
    expect(out.out).not.toContain(`${second} [deliberate]`);
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe('');

    const json = JSON.parse(cli(root, '--review', '--json').out);
    expect(json.proposed).toHaveLength(1);
    expect(json.proposed[0]).toMatchObject({ id: ID, kind: 'rust-bug', userVisible: null });
    expect(json.proposed[0].commits).toHaveLength(1);
    expect(json.approved).toEqual([second]);

    writeFileSync(path.join(root, `${REGISTRY_DIR}/${ID}.json`), JSON.stringify(entry({ id: ID })));
    rmSync(path.join(root, '.git'), { recursive: true, force: true });
    expect(cli(root, '--review').out).toContain('无法读取 git 历史');
  });

  it('CLI exits 1 with file:line on any problem', () => {
    const out = cli(repo(tree(entry(), { 'src/a.ts': '// RUST-FIX(RF-W09-nope): x\n' })), '--check');
    expect(out.code).toBe(1);
    expect(out.out).toContain('src/a.ts:1 [marker] 孤立的 RUST-FIX(RF-W09-nope)');
  });
});
