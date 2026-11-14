#!/usr/bin/env node
// Static check of the G3 selectors of every rust-fixes registration (WAVE2-BRIEF §7) against what
// G3 compares in this tree: whether each selector can ever exempt a difference, and how wide it is.
// Normalization is not touched; the owning lane (RF-<lane>-…) fixes its registration.
//   node scripts/electron-migration/record/g3-rf-check.mjs [--json FILE] [--strict]
// Problems (the selector never exempts anything, or the entry is not loaded at all):
//   entry            entryProblem / not JSON: loadRustFixes drops the whole registration
//   selector         selectorProblem: the comparator cannot evaluate the selector
//   no-scenario      the scenario pattern matches no scenario of the corpus
//   no-command       ipc: no step of a matching scenario runs a matching command
//   no-capture       event: no matching scenario captures events; db / fs: none captures databases
//   no-event         event: matches no channel A subscribes to (g3-run-a frontendEvents names and patterns)
//   event-path       event jsonPath not under $.event or $.payload (the covered record is {event, payload})
//   no-table         db: no table matching it is created by A (src-tauri migrations or source), so on
//                    A's side the table is absent and the difference is a `table` row, never covered
//   no-column        db: A's table has no matching column: a `column` row, never covered
//   fs-path          fs: the path has no `/`, so it can only name a file at the run root, where no
//                    database lies (the fs surface covers database files present on one side only)
// Broad (exempts more than the field a fix changes; for the owner to confirm):
//   whole-outcome    ipc without jsonPath: every difference of the command's outcome, its kind included
//   whole-event      event without jsonPath: every field of every matching event
//   any-scenario     scenario "*": every scenario of the corpus that reaches the place
//   name-wildcard    `*` in command / event / table / column
//   fs-name          fs: the file name has no database extension; only a SQLite header makes it one
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { entryProblem, jsonPathKeys, RUST_FIXES_DIR, selectorProblem } from './g3-rust-fixes.mjs';
import { scanScenarios } from './g3-report.mjs';

export const PROBLEMS = ['entry', 'selector', 'no-scenario', 'no-command', 'no-capture', 'no-event', 'event-path', 'no-table', 'no-column', 'fs-path'];
export const BROAD = ['whole-outcome', 'whole-event', 'any-scenario', 'name-wildcard', 'fs-name'];
const SCHEMA_SOURCES = ['resources/app/migrations', 'src-tauri/src', 'src-tauri/crates', 'host/platform/storage'];
const DATABASE_NAME = /\.(db|db3|sqlite|sqlite3)$/i;

const escape = text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
/** g3-rust-fixes glob: `*` = any characters (in fs paths: one segment). */
export const globRegExp = (pattern, segment = false) => new RegExp(`^${pattern.split('*').map(escape).join(segment ? '[^/]*' : '.*')}$`);
const glob = (pattern, text) => globRegExp(pattern).test(text);

/** Does event glob `pattern` match `name`, or some instance of a frontendEvents pattern (`{}` = a runtime id)? */
export function eventReachable(pattern, { names, patterns }) {
  if (names.some(name => glob(pattern, name))) return true;
  const selector = globRegExp(pattern);
  return patterns.some(channel => {
    const dynamic = new RegExp(`^${channel.split('{}').map(escape).join('.+')}$`);
    const samples = [channel.replaceAll('{}', 'x0'), ...[pattern.replaceAll('*', 'x0'), pattern.replaceAll('*', '')]];
    return samples.some(text => dynamic.test(text) && selector.test(text));
  });
}

function* files(directory, test) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'target' && entry.name !== 'node_modules') yield* files(path, test); }
    else if (test(entry.name)) yield path;
  }
}

/** The parenthesised text starting at `open` (an index of '('), or null when unbalanced. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}

/** Top-level comma items of a column list. */
function items(body) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++;
    else if (body[i] === ')') depth--;
    else if (body[i] === ',' && depth === 0) { out.push(body.slice(start, i)); start = i + 1; }
  }
  out.push(body.slice(start));
  return out.map(item => item.trim()).filter(Boolean);
}

const NAME = '[`"\\[]?([A-Za-z_][A-Za-z0-9_]*)[`"\\]]?';
const CREATE = new RegExp(`CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(VIRTUAL\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(?:${NAME}\\.)?${NAME}\\s*(?:USING\\s+\\w+\\s*)?\\(`, 'gi');
const ALTER = new RegExp(`ALTER\\s+TABLE\\s+(?:${NAME}\\.)?${NAME}\\s+ADD\\s+(?:COLUMN\\s+)?${NAME}`, 'gi');
const NOT_A_COLUMN = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i;
/** SQL comments and single-quoted literals blanked in place (same offsets), so their parentheses and commas do not count. */
const blankLiterals = text => text.replace(/--[^\n]*/g, match => ' '.repeat(match.length))
  .replace(/'[^'\n]*'/g, match => `'${' '.repeat(match.length - 2)}'`);

/** Tables (→ columns) A creates: CREATE [VIRTUAL] TABLE and ALTER TABLE … ADD COLUMN in its SQL migrations and Rust source. */
export function aSchema(root, sources = SCHEMA_SOURCES) {
  const tables = new Map();
  const add = (table, column) => {
    if (!tables.has(table)) tables.set(table, new Set());
    if (column) tables.get(table).add(column);
  };
  for (const source of sources) {
    for (const file of files(join(root, source), name => /\.(sql|rs|ts)$/.test(name))) {
      const text = blankLiterals(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(CREATE)) {
        const table = match[3];
        add(table);
        const body = balanced(text, match.index + match[0].length - 1);
        if (body === null) continue;
        for (const item of items(body)) {
          if (NOT_A_COLUMN.test(item) || (match[1] && item.includes('='))) continue;
          const column = /^[`"[]?([A-Za-z_][A-Za-z0-9_]*)/.exec(item)?.[1];
          if (column) add(table, column);
        }
      }
      for (const match of text.matchAll(ALTER)) add(match[2], match[3]);
    }
  }
  return tables;
}

/** Corpus scenarios: id, step commands, what they capture. */
export function corpusScenarios(root) {
  const { suites } = scanScenarios(root);
  return suites.flatMap(suite => JSON.parse(readFileSync(join(root, suite.file), 'utf8')).scenarios.map(scenario => ({
    file: suite.file, id: scenario.id, commands: (scenario.steps ?? []).map(step => step?.cmd),
    events: scenario.capture?.events === true, db: Array.isArray(scenario.capture?.db) && scenario.capture.db.length > 0 })));
}

/** Findings of one selector; `context` = { scenarios, events, schema }. */
export function selectorFindings(selector, { scenarios, events, schema }) {
  const out = [];
  const add = (kind, detail) => out.push({ kind, detail });
  const problem = selectorProblem(selector);
  if (problem) { add('selector', problem); return { findings: out, reach: null }; }
  const matching = scenarios.filter(scenario => glob(selector.scenario, scenario.id));
  if (!matching.length) add('no-scenario', `scenario ${JSON.stringify(selector.scenario)} matches no scenario of the corpus`);
  let reach = { scenarios: matching.length };
  if (selector.surface === 'ipc') {
    const steps = matching.flatMap(scenario => scenario.commands.filter(command => typeof command === 'string' && glob(selector.command, command)));
    const commands = [...new Set(steps)].sort();
    reach = { scenarios: matching.filter(scenario => scenario.commands.some(command => typeof command === 'string' && glob(selector.command, command))).length, steps: steps.length, commands };
    if (matching.length && !steps.length) add('no-command', `no matching scenario runs ${selector.command}`);
    if (selector.jsonPath === undefined) add('whole-outcome', `any difference of ${selector.command}'s outcome (kind included)`);
  } else if (selector.surface === 'event') {
    reach = { scenarios: matching.filter(scenario => scenario.events).length };
    if (matching.length && !reach.scenarios) add('no-capture', 'no matching scenario captures events');
    if (!eventReachable(selector.event, events)) add('no-event', `${selector.event} matches no channel A subscribes to`);
    if (selector.jsonPath === undefined) add('whole-event', `every field of ${selector.event}`);
    else if (!['event', 'payload'].includes(jsonPathKeys(selector.jsonPath)[0])) add('event-path', `${selector.jsonPath} is not under $.event / $.payload`);
  } else {
    reach = { scenarios: matching.filter(scenario => scenario.db).length };
    if (matching.length && !reach.scenarios) add('no-capture', 'no matching scenario captures databases');
    if (selector.surface === 'db') {
      const tables = [...schema.keys()].filter(table => glob(selector.table, table));
      if (!tables.length) add('no-table', `A creates no table ${selector.table}`);
      else if (!tables.some(table => [...schema.get(table)].some(column => glob(selector.column, column)))) {
        add('no-column', `A's ${tables.join(', ')} has no column ${selector.column}`);
      }
    } else {
      if (!selector.path.includes('/')) add('fs-path', `${selector.path} can only be a file at the run root; databases lie under app-data/… (row.db)`);
      const name = selector.path.split('/').at(-1);
      if (!name.includes('*') && !DATABASE_NAME.test(name)) add('fs-name', `${name} is not a database file name`);
    }
  }
  if (selector.scenario === '*') add('any-scenario', 'every scenario of the corpus');
  const named = { ipc: ['command'], event: ['event'], db: ['table', 'column'], fs: [] }[selector.surface];
  for (const field of named) if (selector[field].includes('*')) add('name-wildcard', `${field} ${selector[field]}`);
  return { findings: out, reach };
}

/** Every registration's selectors checked against the tree at `root`; `context` is injectable for tests. */
export async function checkRustFixSelectors(root, context = null) {
  root = resolve(root);
  if (!context) {
    const { frontendEvents } = await import(pathToFileURL(join(root, 'scripts/electron-migration/record/g3-run-a.mjs')).href);
    context = { scenarios: corpusScenarios(root), events: frontendEvents(join(root, 'contracts/ipc'), join(root, 'src')), schema: aSchema(root) };
  }
  const dir = join(root, RUST_FIXES_DIR);
  const names = existsSync(dir) ? readdirSync(dir).filter(name => /^RF-.*\.json$/.test(name)).sort() : [];
  const registrations = [];
  for (const name of names) {
    const file = `${RUST_FIXES_DIR}/${name}`;
    let entry;
    try { entry = JSON.parse(readFileSync(join(dir, name), 'utf8')); } catch (error) {
      registrations.push({ file, id: null, lane: null, status: null, problems: [{ kind: 'entry', detail: `not JSON: ${error.message}` }], selectors: [] });
      continue;
    }
    const id = typeof entry?.id === 'string' ? entry.id : null;
    const lane = /^RF-([A-Za-z0-9]+)-/.exec(id ?? name)?.[1] ?? null;
    const problem = entryProblem(entry, name);
    const selectors = (Array.isArray(entry?.g3?.selectors) ? entry.g3.selectors : []).map((selector, index) => ({ index, selector, ...selectorFindings(selector, context) }));
    // entryProblem names a selector's problem too; it is listed with that selector.
    const own = problem && !/^g3\.selectors\[\d+\]: /.test(problem) ? [{ kind: 'entry', detail: problem }] : [];
    registrations.push({ file, id, lane, status: entry?.status ?? null, affects: entry?.g3?.affects ?? null, problems: own, selectors });
  }
  const listed = registrations.filter(item => item.problems.length || item.selectors.some(selector => selector.findings.length));
  const count = kinds => Object.fromEntries(kinds.map(kind => [kind, registrations.flatMap(item => [...item.problems, ...item.selectors.flatMap(selector => selector.findings)])
    .filter(finding => finding.kind === kind).length]).filter(([, n]) => n));
  const problemRegistrations = registrations.filter(item => item.problems.length || item.selectors.some(selector => selector.findings.some(finding => PROBLEMS.includes(finding.kind))));
  return { registrations: registrations.length, selectors: registrations.reduce((sum, item) => sum + item.selectors.length, 0),
    problems: count(PROBLEMS), broad: count(BROAD), problemRegistrations: problemRegistrations.map(item => item.id ?? item.file), listed };
}

export function formatReport(result) {
  const lines = [`rust-fixes selectors: ${result.registrations} registrations, ${result.selectors} selectors; problems ${JSON.stringify(result.problems)}, broad ${JSON.stringify(result.broad)}`];
  for (const item of result.listed) {
    lines.push(`${item.id ?? item.file} (${item.lane ?? '?'}, ${item.status ?? '?'})`);
    for (const problem of item.problems) lines.push(`  ! ${problem.kind}: ${problem.detail}`);
    for (const selector of item.selectors.filter(entry => entry.findings.length)) {
      lines.push(`  [${selector.index}] ${JSON.stringify(selector.selector)}${selector.reach ? ` reach ${JSON.stringify(selector.reach)}` : ''}`);
      for (const finding of selector.findings) lines.push(`    ${PROBLEMS.includes(finding.kind) ? '!' : '~'} ${finding.kind}: ${finding.detail}`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { json: { type: 'string' }, strict: { type: 'boolean', default: false }, root: { type: 'string', default: '.' } } });
  const result = await checkRustFixSelectors(values.root);
  if (values.json) writeFileSync(values.json, `${JSON.stringify(result, null, 2)}\n`);
  console.log(formatReport(result));
  if (values.strict && result.problemRegistrations.length) process.exitCode = 1;
}
