#!/usr/bin/env node
// 硬编码用户文案棘轮（WAVE2-BRIEF §8 D5）：前端里没走 i18n 的中英文用户可见文案按 规则+文件 计数，现状登记为基线，只减不增。
//
// 统计的位置（src/ 生产代码；测试、.d.ts、src/demo/、__golden__ 除外）：
//   jsx-text         JSX 文本子节点：<p>保存失败</p>
//   jsx-expression   JSX 子表达式里的字面量：{loading ? '加载中' : 'Load more'}
//   jsx-attribute    文案属性的字面量：title / placeholder / alt / label / aria-label 等（见 COPY_ATTRIBUTES）
//   notification     通知调用的字面量参数：showGlobalNotification / showNotification / notify / toast(.x) /
//                    message.x / notification.x / alert / confirm / prompt（见 isNotificationCall）
// 字面量含字符串、无替换模板、模板的静态片段，并穿过 ?:、||、??、+、括号、as/satisfies 取到两侧。
//
// 什么算“文案”（looksLikeCopy）：
//   - 含汉字、假名或谚文：算；
//   - 只有拉丁字母时，需像一句话：含被空格隔开的两个以上单词、或以句末标点（. ! ? … :）结尾的单词、或首字母大写的
//     单个词（至少三个字母：Save、Cancel；Aa、OK 不算）；不含空格的 key / 标识符 / 路径 / URL（common:save、btn-primary、
//     chat.title、error、https://…）不算；样式类名串（flex items-center）与标识符列表（read_file, write_file）不算；
//     含 {{ }} 插值占位的整串按 i18n 模板算作文案。
//   - 只有数字、符号、emoji、空白：不算。
// 不统计：注释；i18n 调用的整个参数（t / i18n.t / i18next.t / translate / tr… 见 isTranslationCall，包括 key 与
// defaultValue）；<Trans> 及 <code>/<kbd>/<pre>/<style>/<script> 内的文本；日志（console / debugLog 等不在上面的
// 通知调用之列）；className / style / id / key / data-* / href / type 等非文案属性（只看 COPY_ATTRIBUTES）；
// throw new Error(…)；对象字面量里的数据表（{ label: '…' }，已知盲区，见报告）。
//
// 基线 hardcoded-copy-baseline.json 按 规则+文件 计数；重写基线时计数只能减少，增加须显式 --allow-increase。
//
//   node scripts/electron-migration/gate-checks/hardcoded-copy.mjs [--check] [--json] [--root <dir>]
//   node scripts/electron-migration/gate-checks/hardcoded-copy.mjs --write-baseline [--allow-increase]
//   node scripts/electron-migration/gate-checks/hardcoded-copy.mjs --inventory [--top <n>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, files, production, source, ts } from './common.mjs';
import { lineOf } from './ast.mjs';
import { applyCountBaseline, countBaselineEntries } from './baseline.mjs';

export const BASELINE_FILE = 'scripts/electron-migration/gate-checks/hardcoded-copy-baseline.json';
const SCRIPT = /\.(?:[cm]?[jt]sx?)$/;

export const COPY_ATTRIBUTES = new Set([
  'title', 'placeholder', 'alt', 'label', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-placeholder',
  'aria-valuetext', 'tooltip', 'description', 'helperText', 'hint', 'emptyText', 'emptyMessage', 'confirmText',
  'cancelText', 'okText', 'submitText', 'message', 'subtitle', 'heading', 'caption',
]);
const NOTIFICATION_FUNCTIONS = new Set(['showGlobalNotification', 'showNotification', 'notify', 'toast', 'alert', 'confirm', 'prompt']);
const NOTIFICATION_OBJECTS = new Set(['toast', 'message', 'notification']);
const NOTIFICATION_METHODS = new Set(['success', 'error', 'info', 'warning', 'warn', 'loading', 'show', 'open']);
const TRANSLATION_FUNCTIONS = new Set(['t', 'tr', 'translate', 'i18nT', '$t']);
const RAW_TEXT_ELEMENTS = new Set(['Trans', 'code', 'kbd', 'pre', 'style', 'script']);

const MESSAGES = {
  'jsx-text': 'JSX 里的硬编码文案；改用 t(\'ns:key\') 并在 zh-CN / en-US 补词条',
  'jsx-expression': 'JSX 表达式里的硬编码文案；改用 t(\'ns:key\') 并在 zh-CN / en-US 补词条',
  'jsx-attribute': '文案属性的硬编码值；改用 t(\'ns:key\') 并在 zh-CN / en-US 补词条',
  notification: '通知里的硬编码文案；改用 t(\'ns:key\') 并在 zh-CN / en-US 补词条',
};

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LETTER = /\p{L}/u;

/** 一段静态文本是否像用户可见文案（规则见文件头）。 */
export function looksLikeCopy(raw) {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || !LETTER.test(text)) return false;
  if (CJK.test(text)) return true;
  if (/\{\{\s*\w+\s*\}\}/.test(text) && /[A-Za-z]{2,}/.test(text.replace(/\{\{[^}]*\}\}/g, ''))) return true;
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.\.?\/|#|@)/i.test(text)) return false;
  const tokens = text.split(' ');
  // 样式类名串（flex items-center、text-sm font-medium）：全小写、全是类名字符，且有带连字符或变体前缀的词。
  if (tokens.every((w) => /^[a-z0-9:/[\]().%#_!-]+$/.test(w)) && tokens.some((w) => /[a-z0-9][-:][a-z0-9[]/.test(w))) return false;
  // 标识符列表（read_file, write_file）：每个词都是代码标识符，且至少一个带下划线。
  if (tokens.every((w) => /^[\w.,/-]+$/.test(w)) && tokens.some((w) => /[a-z0-9]_[a-z0-9]/i.test(w))) return false;
  const words = tokens.filter((w) => /[A-Za-z]{2,}/.test(w));
  if (words.length >= 2) return true;
  if (words.length === 1 && tokens.length === 1) {
    if (/^[A-Za-z][a-z]+[.!?…:]$/.test(text)) return true;
    return /^[A-Z][a-z]{2,}$/.test(text);
  }
  return false;
}

export function inScope(file) {
  return file.startsWith('src/') && SCRIPT.test(file) && production(file) && !file.endsWith('.d.ts')
    && !file.startsWith('src/demo/') && !/(^|\/)__golden__\//.test(file);
}

const calleeName = (expr) => (ts.isIdentifier(expr) ? expr.text : ts.isPropertyAccessExpression(expr) ? expr.name.text : null);

function isTranslationCall(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return TRANSLATION_FUNCTIONS.has(callee.text);
  return ts.isPropertyAccessExpression(callee) && callee.name.text === 't';
}

function isNotificationCall(node) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return NOTIFICATION_FUNCTIONS.has(callee.text);
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const owner = calleeName(callee.expression);
  if (owner && NOTIFICATION_OBJECTS.has(owner) && NOTIFICATION_METHODS.has(callee.name.text)) return true;
  // deps.showNotification(…)、window.alert(…)、this.notify(…)
  return NOTIFICATION_FUNCTIONS.has(callee.name.text) && callee.name.text !== 'toast';
}

const tagName = (el) => {
  const tag = ts.isJsxElement(el) ? el.openingElement.tagName : el.tagName;
  return ts.isIdentifier(tag) ? tag.text : ts.isPropertyAccessExpression(tag) ? tag.name.text : tag.getText();
};

/** 表达式里会原样显示的静态文本节点（穿过 ?:、||、??、+、括号、断言；不进 i18n 调用与其他调用）。 */
export function copyLiterals(expr) {
  const out = [];
  const visit = (e) => {
    if (!e) return;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression?.(e) || ts.isNonNullExpression(e)) return visit(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      if (looksLikeCopy(e.text)) out.push({ node: e, text: e.text });
      return;
    }
    if (ts.isTemplateExpression(e)) {
      const statics = [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(' {} ');
      if (looksLikeCopy(statics.replace(/\{\}/g, ' '))) out.push({ node: e, text: statics });
      for (const span of e.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isConditionalExpression(e)) { visit(e.whenTrue); visit(e.whenFalse); return; }
    if (ts.isBinaryExpression(e)) {
      const op = e.operatorToken.kind;
      if (op === ts.SyntaxKind.PlusToken) { visit(e.left); visit(e.right); return; }
      if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) { visit(e.left); visit(e.right); return; }
      if (op === ts.SyntaxKind.AmpersandAmpersandToken) { visit(e.right); return; }
    }
  };
  visit(expr);
  return out;
}

/** @param {{file: string, text: string}[]} entries */
export function scanHardcodedCopy(entries) {
  const findings = [];
  for (const { file, text } of entries) {
    if (!inScope(file)) continue;
    const sf = source(file, text);
    const add = (rule, node, copy) => findings.push({ rule, file, line: lineOf(sf, node), text: copy.replace(/\s+/g, ' ').trim().slice(0, 80), message: MESSAGES[rule] });
    const visit = (node, raw) => {
      if (ts.isCallExpression(node) && isTranslationCall(node)) return;
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && RAW_TEXT_ELEMENTS.has(tagName(node))) raw = true;
      if (ts.isJsxText(node) && !raw && looksLikeCopy(node.text)) add('jsx-text', node, node.text);
      else if (ts.isJsxExpression(node) && node.expression && !raw && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
        for (const l of copyLiterals(node.expression)) add('jsx-expression', l.node, l.text);
      } else if (ts.isJsxAttribute(node) && node.initializer) {
        const name = node.name.getText(sf);
        if (COPY_ATTRIBUTES.has(name)) {
          const init = node.initializer;
          const lits = ts.isStringLiteral(init) ? (looksLikeCopy(init.text) ? [{ node: init, text: init.text }] : []) : copyLiterals(init.expression);
          for (const l of lits) add('jsx-attribute', l.node, l.text);
        }
      } else if (ts.isCallExpression(node) && isNotificationCall(node)) {
        for (const arg of node.arguments) {
          for (const l of copyLiterals(arg)) add('notification', l.node, l.text);
          if (ts.isObjectLiteralExpression(arg)) {
            for (const p of arg.properties) {
              if (ts.isPropertyAssignment(p) && ['title', 'message', 'description', 'body'].includes(p.name.getText(sf).replace(/['"]/g, ''))) {
                for (const l of copyLiterals(p.initializer)) add('notification', l.node, l.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, (child) => visit(child, raw));
    };
    visit(sf, false);
  }
  return findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

const keyOf = (f) => `${f.rule}\u0000${f.file}`;
export const applyBaseline = (findings, baseline) => applyCountBaseline(findings, baseline, keyOf);
export const baselineFrom = (findings, previous = { entries: [] }) =>
  countBaselineEntries(findings, previous, keyOf, (f) => ({ rule: f.rule, file: f.file }), [(e) => e.file, (e) => e.rule]);

export function baselineGrowth(previous, entries) {
  const before = new Map((previous?.entries ?? []).map((e) => [keyOf(e), e.count ?? 1]));
  return entries.filter((e) => e.count > (before.get(keyOf(e)) ?? 0))
    .map((e) => ({ rule: e.rule, file: e.file, from: before.get(keyOf(e)) ?? 0, to: e.count }));
}

/** 按文件汇总（降序），供 --inventory 与报告使用。 */
export function inventory(findings, top = 20) {
  const byFile = new Map();
  const byRule = {};
  for (const f of findings) {
    byFile.set(f.file, (byFile.get(f.file) ?? 0) + 1);
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }
  const ranked = [...byFile].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return { total: findings.length, files: byFile.size, byRule, top: ranked.slice(0, top).map(([file, count]) => ({ file, count })) };
}

export function run({ root = ROOT } = {}) {
  const entries = files(root, 'src').filter(inScope).map((file) => ({ file, text: fs.readFileSync(path.join(root, file), 'utf8') }));
  const findings = scanHardcodedCopy(entries);
  const baselinePath = path.join(root, BASELINE_FILE);
  const hasBaseline = fs.existsSync(baselinePath);
  const baseline = hasBaseline ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : { entries: [] };
  const { fresh, stale } = applyBaseline(findings, baseline);
  const byRule = {};
  for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  return {
    gate: 'hardcoded-copy',
    findings: [...fresh, ...stale.map((e) => ({ ...e, line: 1, message: `基线项已减少（现 ${e.present}/${e.count ?? 1}），请重写基线把计数降下来` }))],
    all: findings,
    summary: { files: entries.length, existing: findings.length, byRule, baselined: findings.length - fresh.length, fresh: fresh.length, stale: stale.length },
    baseline,
    hasBaseline,
  };
}

function main(argv) {
  const root = argv.includes('--root') ? path.resolve(argv[argv.indexOf('--root') + 1]) : ROOT;
  const result = run({ root });
  if (argv.includes('--inventory')) {
    const top = argv.includes('--top') ? Number(argv[argv.indexOf('--top') + 1]) : 20;
    const inv = inventory(result.all, top);
    if (argv.includes('--json')) { console.log(JSON.stringify(inv, null, 2)); return; }
    const rules = Object.entries(inv.byRule).map(([r, n]) => `${r} ${n}`).join(', ');
    console.log(`hardcoded-copy: ${inv.total} literals in ${inv.files} files (${rules}); baseline ${BASELINE_FILE}`);
    for (const { file, count } of inv.top) console.log(`${String(count).padStart(6)}  ${file}`);
    return;
  }
  if (argv.includes('--write-baseline')) {
    const entries = baselineFrom(result.all, result.baseline);
    const growth = result.hasBaseline ? baselineGrowth(result.baseline, entries) : [];
    if (growth.length && !argv.includes('--allow-increase')) {
      console.log('hardcoded-copy: 基线计数只能减少；以下项会增加（确需登记请加 --allow-increase 并在评审中说明）：');
      for (const g of growth) console.log(`  ${g.rule} ${g.file} ${g.from} → ${g.to}`);
      process.exitCode = 1;
      return;
    }
    const description = result.baseline.description
      ?? 'WAVE2-BRIEF §8 D5 硬编码用户文案基线（按 规则+文件 计数，只减不增）。规则见 hardcoded-copy.mjs 文件头。';
    fs.writeFileSync(path.join(root, BASELINE_FILE), `${JSON.stringify({ description, entries }, null, 1)}\n`);
    console.log(`wrote ${entries.length} baseline entries (${result.all.length} findings)`);
    return;
  }
  if (argv.includes('--json')) console.log(JSON.stringify({ ...result, baseline: undefined }, null, 2));
  else {
    const s = result.summary;
    const rules = Object.entries(s.byRule).map(([r, n]) => `${r} ${n}`).join(', ') || 'none';
    console.log(`hardcoded-copy: ${s.files} files; ${s.existing} known (${rules}), ${s.baselined} baselined, ${s.fresh} new, ${s.stale} stale baseline entries`);
    for (const f of result.findings) console.log(`${f.file}:${f.line ?? 1} [${f.rule}${f.severity === 'info' ? ', info' : ''}] ${f.message}${f.text ? `：${f.text}` : ''}`);
  }
  if (argv.includes('--check') && result.findings.some((f) => f.severity === 'error')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(e.stack); process.exitCode = 2; }
}
