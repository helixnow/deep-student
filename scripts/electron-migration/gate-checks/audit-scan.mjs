import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './common.mjs';

const name = process.argv[2];
if (!['single-writer', 'unchecked-decode', 'prod-reachable', 'assert-parity', 'log-parity'].includes(name)) throw new Error('Expected a gate name');
const { run } = await import(`./${name}.mjs`);
const result = await run({ root: ROOT, changed: null });
const dir = path.join(ROOT, 'scripts/electron-migration/gate-checks/reports');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(result, null, 2) + '\n');
const lines = [`\n## ${name} 全仓快照\n`, `发现 ${result.summary.count} 条（包含 info）；完整明细：\`scripts/electron-migration/gate-checks/reports/${name}.json\`。`, '', '| 插件 | 条数 |', '|---|---:|', ...Object.entries(result.summary.byPlugin).sort().map(([p, n]) => `| ${p} | ${n} |`), '', '典型样例：', ...result.findings.slice(0, 6).map(f => `- \`${f.file}:${f.line ?? 1}\` [${f.rule}] ${f.message}`)];
if (result.ambiguous) lines.push(`\n所有权待裁定 ${result.ambiguous.length} 张表，详见 registry 的 ambiguous；本次未知所有权写点 ${result.unknown.length}。`);
if (result.impact) lines.push(`\nA 级影响：${JSON.stringify(result.impact)}。`);
const audit = path.join(ROOT, 'docs/dev/electron-migration/audits/X6-gate-checks.md');
const old = fs.readFileSync(audit, 'utf8');
const section = new RegExp(`\\n## ${name} 全仓快照\\n[\\s\\S]*?(?=\\n## |$)`);
fs.writeFileSync(audit, old.replace(section, '') + lines.join('\n') + '\n');
console.log(JSON.stringify({ summary: result.summary, ambiguous: result.ambiguous?.length, impact: result.impact }, null, 2));
