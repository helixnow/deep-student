#!/usr/bin/env node
// Group existing residual diffs only. Does not record, normalize, recompute, or assign pass.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compareFiles, APPROVALS } from './g3-manifest.mjs';
import { firstDifference, parseExact, readEvidence } from './json.mjs';
import { normalizerSha256 } from './g3-normalize.mjs';

const root = process.cwd();
const runs = process.argv[2] ?? 'fixtures/differential/g3/runs/full';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const version = normalizerSha256(root), approvals = sha(readFileSync(APPROVALS));
const inventory = JSON.parse(readFileSync('scripts/electron-migration/frontend-audit/wave0-inventory.json'));
const owners = new Map(inventory.commands.map(item => [item.name, { lane: item.owner?.lane, rust: item.rust }]));
const rows = new Map(), inputs = [], stale = [], unreadable = [];
let equal = 0;
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');

const focus = {
  get_app_data_dir: ['产品差', 'F2-shell', 'electron/index.ts:86', '返回 base 而非活动 slot；N-007 后 slots/slotA 后缀仍不同。Rust src-tauri/src/commands.rs:563。'],
  cloud_config_ssot_save: ['产品差', 'F4-security / L21-backup / F5-contracts', 'host/platform/errors/cloud-config-commands.ts:11', '区分字段 allowInsecure/allow_insecure、校验错误文本和业务结果；非随机值，不能归一化。'],
  cloud_config_ssot_get: ['产品差', 'L21-backup / F4-security', 'host/plugins/backup/src/cloud-config.ts:738', '未配置视图 B 显式 null，Rust CloudConfigSsotResponse:117 的 skip_serializing_if 省略字段；missing≠null。'],
  save_text_to_file: ['产品差（上游传播）', 'F2-shell', 'electron/index.ts:86', 'args 路径中 slot/base 后缀差来自 get_app_data_dir；不要逐命令重写参数或扩张 N-007。'],
  copy_file: ['产品差（上游传播）', 'F2-shell', 'electron/index.ts:86', '与 save_text_to_file 同一上游目录语义差；复制实现入口 electron/index.ts:116。'],
  read_file_text: ['产品差候选（需按样例分支复核）', 'F2-shell', 'electron/index.ts:86', '目录派生参数差与独立错误文本差分开，不应统一忽略路径。'],
  pdfstream_check_access: ['环境/驱动限制（非豁免）', 'X7-differential / F2-shell', 'scripts/electron-migration/record/g3-run-b.mjs:57', 'B runner 对所有 shell-request 返回错误；命令 electron/index.ts:135 先请求 app.pdfStreamAllowedDirs。需要真实 main 驱动或 C2 登记 blocker；不能归一化 outcome-kind。'],
};

function valueProposal(sample) {
  if (sample?.kind !== 'value' || sample.before?.storageClass !== 'text' || sample.after?.storageClass !== 'text') return null;
  let a, b;
  try { a = parseExact(sample.before.value); b = parseExact(sample.after.value); } catch { return null; }
  if (!firstDifference(a, b)) return 'N-009';
  const stripUnixIdentity = value => {
    if (!value || typeof value !== 'object' || JSON.isRawJSON(value)) return value;
    if (Array.isArray(value)) return value.map(stripUnixIdentity);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'identity' && item?.kind === 'unix'
        ? Object.fromEntries(Object.entries(item).filter(([name]) => !['inode', 'device'].includes(name)))
        : stripUnixIdentity(item)]));
  };
  return firstDifference(stripUnixIdentity(a), stripUnixIdentity(b)) === null ? 'N-008' : null;
}

function classify(d, sample) {
  if (!sample && focus[d.command]) return focus[d.command];
  if (sample) {
    const table = sample.table ?? '';
    const proposal = valueProposal(sample);
    if (proposal === 'N-009') return ['表示顺序差候选（申请 N-009，未批准）', 'C2-platform / 对应表 owner', 'host/e2e/data-compat/__fixtures__/database-state.ts:170', '双方 text 值均按 exact JSON 解析后完全相等，仅编码对象键顺序不同；不能自行把所有 JSON 文本 canonicalize。'];
    if (proposal === 'N-008') return ['环境文件身份差候选（申请 N-008，未批准）', 'C2-platform / L05-agent-workspace', 'host/plugins/agent-workspace/src/runtime-roots.ts:123', '仅 unix identity 的 inode/device 不同，其余解析值相等；副本文件不同 inode，需精确路径规则与 A1/A2 证据。'];
    if (/sync_state\.db$/.test(sample.db)) return ['环境/启动范围差候选', 'L20-sync / F3-storage', 'host/platform/storage/locations.ts:350', '核对 seed/XDG 与启动 finalizer，历史 WP-262/278 不得当成已批准单文件排除。'];
    if (table === '__change_log' && sample.column === 'changed_at') return ['环境时间候选（未批准，保留差异）', 'C2-platform / L20-sync', 'host/platform/storage/startup-finalizers.ts:53', '精确 db/table/column 不在 N-001 清单时不得扩展；先核对 A1/A2 同位置及日志行对应关系，再申请规则。'];
    if (table === '__change_log') return ['产品/日志顺序差候选', 'L20-sync / 表所属 owner', 'host/platform/storage/startup-finalizers.ts:53', 'operation/table_name/record_id/行数仍是证据；不能以时间戳为由忽略整表。'];
    if (table === 'vfs_indexing_config') return ['产品/启动默认行差候选', 'L13-vfs-api / F3-storage', 'host/platform/storage/startup-finalizers.ts:53', '缺省 key/value 行不是时间戳；复核启动迁移，不归一化。'];
    if (table === 'settings') return ['产品/设置状态差候选', 'L02-llm-manager / F3-storage / 对应 key owner', 'host/platform/storage/startup-finalizers.ts:53', '缺行或 value 差保留；quick_assistant.window_bounds.v3 属 L17-memory / headless shell 副作用，需单独核对。'];
    if (/custom_anki_templates|anki_cards/.test(table)) return ['产品/模板与卡片内容差候选', 'L16-anki', 'host/plugins/anki/index.ts:1', 'CSS/模板/版本/extra_fields_json 都非可整列忽略的随机 ID；由 owner 复核实际行。'];
    if (/^chat_v2/.test(table)) return ['产品/会话存储差候选', 'L03-chat-db / L04-chat-session', 'host/plugins/chat/index.ts:1', 'FTS blob/行缺失/内容与时间列分别复核；不扩张已有随机 ID 规则。'];
    if (/folder|note_document/.test(table)) return ['产品/笔记与 VFS 存储差候选', 'L13-vfs-api / L10-notes', 'host/plugins/vfs-repos/index.ts:1', '引用结构、缺行、修订版本保持原样，请 owner 按 sample.key 定位。'];
    return ['待 owner 复核（仍为差异）', 'C2-platform 路由表所属 owner', 'host/e2e/data-compat/__fixtures__/database-state.ts:151', '未找到可批准的环境投影；禁止据表名整表忽略。'];
  }
  const owner = owners.get(d.command);
  const source = owner?.rust?.file ? `${owner.rust.file}:${owner.rust.line}` : 'scripts/electron-migration/record/g3-compare.mjs:120';
  return ['产品差候选（未作环境豁免）', owner?.lane ?? 'C2-platform 路由', source, '这是规范化后的剩余差异；附原件供 owner 复核，不把 candidate 冒充已确认根因。'];
}

function add(d, sample, file, hash, artifact) {
  const key = sample ? ['database-sample', sample.kind, sample.db, sample.table, sample.column, valueProposal(sample)] : [d.kind, d.command];
  const id = JSON.stringify(key);
  if (!rows.has(id)) {
    const [classification, owner, source, disposition] = classify(d, sample);
    rows.set(id, { key, classification, owner, source, disposition, occurrences: 0, evidence: {
      file, sha256: hash, scenario: artifact.scenario, step: d.step, command: d.command, where: d.where ?? null,
      difference: sample ?? d, traces: artifact.traces,
    } });
  }
  rows.get(id).occurrences++;
}

for (const file of compareFiles(root, runs)) {
  let bytes, artifact;
  try { const evidence = readEvidence(join(root, file)); bytes = evidence.bytes; artifact = JSON.parse(evidence.text); }
  catch (error) { unreadable.push({ file, reason: error.message }); continue; }
  const hash = sha(bytes);
  if (artifact.normalizer?.sha256 !== version || artifact.approvals?.sha256 !== approvals) { stale.push({ file, sha256: hash }); continue; }
  inputs.push({ file, sha256: hash });
  if (artifact.equal) equal++;
  for (const diff of artifact.differences) {
    add(diff, null, file, hash, artifact);
    for (const sample of diff.sample ?? []) add(diff, sample, file, hash, artifact);
  }
}
const groups = [...rows.values()].sort((a, b) => b.occurrences - a.occurrences);
// Raw A1/A2 values for the first representative of each new proposal. No trace is edited.
const environmentProposals = [];
for (const proposal of ['N-008', 'N-009']) {
  const group = groups.find(row => row.key.at(-1) === proposal);
  if (!group) continue;
  const { evidence } = group, sample = evidence.difference;
  const takes = {};
  for (const side of ['A', 'A2', 'B']) {
    const ref = evidence.traces[side];
    if (!ref) continue;
    try {
      const { bytes, text } = readEvidence(join(root, ref.file));
      const trace = JSON.parse(text);
      const state = evidence.where === 'before' ? trace.before.databases : evidence.where === 'after' ? trace.after.databases
        : evidence.where?.startsWith('after step ') ? trace.calls[Number(evidence.where.slice(11))].capture.databases : trace.finalDatabases;
      const row = state?.databases?.[sample.db]?.tables?.[sample.table]?.rows.find(row => JSON.stringify(row.key) === JSON.stringify(sample.key));
      takes[side] = { file: ref.file, sha256: sha(bytes), value: row?.values?.[sample.column] ?? null };
    } catch (error) { takes[side] = { file: ref.file, unavailable: error.message }; }
  }
  environmentProposals.push({ proposal, approval: 'pending C2; not applied', db: sample.db, table: sample.table, column: sample.column,
    key: sample.key, where: evidence.where, compare: { file: evidence.file, sha256: evidence.sha256 }, takes });
}
const report = { schema: 'g3-diff-triage/v1', at: new Date().toISOString(), normalizerSha256: version, approvalsSha256: approvals,
  counts: { compareArtifacts: inputs.length, equalArtifacts: equal, unequalArtifacts: inputs.length - equal, stale: stale.length, unreadable: unreadable.length },
  note: 'Artifact/sample counts only, not 768 command statuses. Samples are capped by comparator; counts are lower bounds. Candidates need owner/C2 review.',
  inputs, stale, unreadable, environmentProposals, groups };
const lines = ['# G3 剩余差异归类（现有产物快照）', '', `生成时间 ${report.at}；规则版本 normalizer=${version}，approvals=${approvals}。`,
  `compare ${inputs.length}：equal ${equal} / unequal ${inputs.length - equal}；过期 ${stale.length}，不可读 ${unreadable.length}。这不是命令级 pass/fail。`,
  '仅归类现有 differences（已执行 N-001…N-007）；不再次修改规则/trace，不启动或停止录制。sample 有 50 条截断，计数是下界。', '',
  '## 重点结论', '',
  '- `get_app_data_dir`：N-007 后 A 为 `<run>/app-data/com.deepstudent.differential/slots/slotA`，B 为 `<run>/app-data/com.deepstudent.differential`；是目录语义差，不是随机根路径。',
  '- `save_text_to_file` / `copy_file` 的 slot/base 参数差来自上一条返回值。修目录语义，不逐命令 mask。',
  '- `cloud_config_ssot_get`：Rust 省略 None（serde skip_serializing_if），B 显式 null；`save` 还存在参数校验错误原文差。均需 owner 修正，不属于 N-003。',
  '- `pdfstream_check_access`：B 驱动拒绝 app.pdfStreamAllowedDirs shell 请求，不能以环境原因把 result/error 判 equal；请 C2 指派驱动补齐或登记 blocker。',
  '- `vfs_indexing_config` 缺省行、`sync_state.db` 存在性：本快照样本中若为零，表示未再观察到，非对所有 trace 的豁免；旧批修复需由 C2 对照 WP-262/278 与 startup finalizer receipts。',
  '- `settings` 必须按 key 分派：快照中的 quick_assistant.window_bounds.v3 与启动默认行不是同类问题；CSS/模板正文/配置值不能借随机 ID 规则消除。',
  '- `__change_log.changed_at` 剩余时间值只是环境候选；未批准扩展不投影。operation/table_name/record_id 或日志序列差仍须查写入行为。', '',
  '- N-008 候选：JSON 字符串中 unix identity 的 inode/device，仅当其余解析值相等；N-009 候选：DB text 中 exact JSON 值相等但对象键编码顺序不同。两者均未批准、未应用，逐项原件见 JSON environmentProposals。', '',
  '## 分组（每组代表证据的完整 difference、trace 路径及 SHA-256 见 DIFF-TRIAGE.json）', '',
  '| 类型/命令或 DB/table/column | 次数 | 归类 | owner | 源码定位 | 处置 | 代表证据 |',
  '|---|---:|---|---|---|---|---|'];
for (const row of groups) lines.push(`| ${cell(row.key.join(' / '))} | ${row.occurrences} | ${cell(row.classification)} | ${cell(row.owner)} | ${cell(row.source)} | ${cell(row.disposition)} | ${cell(row.evidence.file)}@${row.evidence.sha256} |`);
lines.push('', '## 说明', '', '候选不等于已确诊产品缺陷，也不等于 C2 已批准的环境限制。未取得 A1/A2 与 owner 复核前保留 fail；X7 不修改 owner 实现。', '当前批仍在录制；本文件不是 final G3 账本，不能拿 equal artifact 数作为 pass/768。', '');
writeFileSync(join(runs, 'DIFF-TRIAGE.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(runs, 'DIFF-TRIAGE.json.gz'), gzipSync(Buffer.from(JSON.stringify(report) + '\n')));
writeFileSync(join(runs, 'DIFF-TRIAGE.md'), lines.join('\n'));
console.log(JSON.stringify({ ...report.counts, groups: groups.length, output: join(runs, 'DIFF-TRIAGE.md') }));
