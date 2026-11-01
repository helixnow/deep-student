#!/usr/bin/env node
// ============================================================================
// 从 OpenCode Go 官方文档生成 scripts/opencode-go-plans.json
//
// 官方没有公开接口提供各模型的月额度与预估请求数，只在文档页的表格里给出。
// 本脚本解析文档 HTML 中的表格（套餐表之后依次为：Go / Go Plus / Go Teams 的
// 「用量上限」三张表、三张「预估请求数」表、端点表、数据政策表），生成随版本发布
// 的静态数据。官网变更时重新运行并人工核对 diff。
//
// 用法：
//   node scripts/generate-opencode-go-plans.mjs                 # 抓取官网
//   node scripts/generate-opencode-go-plans.mjs ./saved.html    # 使用本地保存的页面
//   node scripts/generate-opencode-go-plans.mjs --check         # 只校验，不写文件（不一致时退出码 1）
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL = 'https://opencode.ai/docs/go/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(ROOT, 'scripts', 'opencode-go-plans.json');
const PLANS = ['go', 'go_plus', 'go_teams'];

const decode = (text) =>
  text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

export function parseTables(html) {
  return [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map(([table]) =>
    [...table.matchAll(/<tr[\s\S]*?<\/tr>/g)].map(([row]) =>
      [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((cell) => decode(cell[1])),
    ),
  );
}

const header = (table) => (table[0] ?? []).join(' | ');
const rows = (table) => table.slice(1);
// 价格表里同一模型按上下文长度 / 峰谷时段拆成多行，月额度相同：取括号前的模型名。
const baseName = (name) => name.replace(/\s*\((?:≤|>|Peak|Off-Peak|\d+% off)[^)]*\)\s*$/, '').trim();
const amount = (text) => {
  const match = text.replace(/,/g, '').match(/^\$?([0-9.]+)$/);
  return match ? Number(match[1]) : null;
};

export function buildPlans(html, verifiedAt) {
  const tables = parseTables(html);
  const limitTables = tables.filter((table) => header(table).endsWith('| Monthly limit'));
  const requestTables = tables.filter((table) => header(table).startsWith('Model | Requests per 5 hours'));
  const endpointTable = tables.find((table) => header(table).startsWith('Model | Model ID | Endpoint'));
  const policyTable = tables.find((table) => header(table).startsWith('Model | Model training'));
  if (limitTables.length !== 3 || requestTables.length !== 3 || !endpointTable || !policyTable) {
    throw new Error(
      `文档结构已变化：limit=${limitTables.length} requests=${requestTables.length} endpoint=${Boolean(endpointTable)} policy=${Boolean(policyTable)}`,
    );
  }
  const training = new Map(rows(policyTable).map((row) => [row[0], row[1] === 'Yes']));

  const models = rows(endpointTable).map(([name, id, endpoint]) => {
    const protocol = endpoint.includes('/anthropic/')
      ? 'anthropic_messages'
      : endpoint.includes('/google/')
        ? 'google_generate_content'
        : endpoint.endsWith('/responses')
          ? 'openai_responses'
          : 'openai_chat_completions';
    const model = {
      id,
      name,
      protocol,
      training_permitted: training.get(name) ?? false,
      monthly_limit_usd: {},
      estimated_requests: {},
    };
    PLANS.forEach((plan, index) => {
      const limitRow = rows(limitTables[index]).find((row) => baseName(row[0]) === name);
      if (!limitRow) throw new Error(`${plan} 用量表缺少模型：${name}`);
      model.monthly_limit_usd[plan] = amount(limitRow[limitRow.length - 1]);
      const requestRow = rows(requestTables[index]).find((row) => row[0] === name);
      model.estimated_requests[plan] =
        requestRow && amount(requestRow[1]) !== null
          ? { five_hour: amount(requestRow[1]), week: amount(requestRow[2]), month: amount(requestRow[3]) }
          : null;
    });
    return model;
  });

  return {
    schema_version: '1.0',
    verified_at: verifiedAt,
    source: SOURCE_URL,
    purpose:
      'OpenCode Go 各模型在 Go / Go Plus / Go Teams 下的月额度（美元，按标价折算：决定该模型用量占共享的 5 小时 / 周 / 月额度的比例）与官方预估请求数。官方无公开接口提供此表，由 scripts/generate-opencode-go-plans.mjs 从文档页生成，随版本发布。免费型号额度为 null（官方标注 Unlimited，限时）。',
    plans: [
      { id: 'go', name: 'Go', price_usd_per_month: 10 },
      { id: 'go_plus', name: 'Go Plus', price_usd_per_month: 40 },
      { id: 'go_teams', name: 'Go Teams', price_usd_per_month: 20, per_member: true },
    ],
    models,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const file = args.find((arg) => !arg.startsWith('--'));
  const html = file
    ? fs.readFileSync(file, 'utf8')
    : await fetch(SOURCE_URL, { headers: { 'User-Agent': 'DeepStudent-docs-sync/1.0' } }).then((response) => {
        if (!response.ok) throw new Error(`抓取失败：HTTP ${response.status}`);
        return response.text();
      });
  const previous = fs.existsSync(OUTPUT) ? JSON.parse(fs.readFileSync(OUTPUT, 'utf8')) : null;
  const next = buildPlans(html, new Date().toISOString().slice(0, 10));
  const comparable = (doc) => JSON.stringify({ ...doc, verified_at: undefined });
  const changed = !previous || comparable(previous) !== comparable(next);
  if (check) {
    console.log(changed ? 'opencode-go-plans.json 与官网不一致，请重新生成并核对' : 'opencode-go-plans.json 与官网一致');
    process.exit(changed ? 1 : 0);
  }
  if (!changed) {
    console.log('数据无变化；仅更新 verified_at');
  }
  fs.writeFileSync(OUTPUT, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`已写入 ${path.relative(ROOT, OUTPUT)}：${next.models.length} 个模型`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
