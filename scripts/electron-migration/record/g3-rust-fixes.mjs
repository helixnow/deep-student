// Rust-fix registrations (WAVE2-BRIEF §7): host/e2e/differential/rust-fixes/RF-*.json.
// An approved entry's selectors exempt exactly the G3 differences they cover; a proposed
// entry's hits stay counted and are listed as pending. Coverage is all-or-nothing per
// difference: every differing place of it must lie inside some selector of one entry, and a
// difference whose differing places are not completely known (truncated sample, path list cut
// off, artifact without path lists) is never covered.
//
// Differing places of a G3 difference record, and the selectors that cover them
// (`*` in scenario / table / column / command / event = any characters; in fs path = one segment):
//   outcome            each of difference.paths (pathsComplete)  ipc command; jsonPath: path under it
//   outcome-kind,      the whole outcome                          ipc command without jsonPath
//   expectation
//   events             each of difference.paths /<i>/…, with      event matching every non-null
//                      eventNames[i].A/.B                         name; jsonPath relative to the
//                                                                 event record {event, payload}:
//                                                                 path under /<i><jsonPath>
//   database,          each sample row (sample.length == count)
//   final-database       value / storageClass on table.column      db table + column; jsonPath: both
//                                                                 cells JSON, equal once every
//                                                                 matching selector's place is masked
//                        database (file on one side only)         fs path matching row.db
//   args, anything else never covered (arguments are input)
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstDifference, parseExact, stringifyExact } from './json.mjs';

export const RUST_FIXES_DIR = 'host/e2e/differential/rust-fixes';
export const KINDS = ['rust-bug', 'deliberate'];
export const STATUSES = ['proposed', 'approved'];
const SURFACES = { db: ['table', 'column'], event: ['event'], ipc: ['command'], fs: ['path'] };
const SELECTOR_KEYS = ['scenario', 'surface', 'table', 'column', 'event', 'command', 'path', 'jsonPath'];
const PATH_LIMIT = 64;

const pointer = (path, key) => `${path}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && !JSON.isRawJSON(value);

/** Every differing JSON pointer between two values (sorted object keys, array indices), up to `limit`. */
export function differingPaths(a, b, limit = PATH_LIMIT) {
  const paths = [];
  let complete = true;
  const push = path => {
    if (paths.length < limit) paths.push(path);
    else complete = false;
  };
  const walk = (left, right, path) => {
    if (!complete) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        if (i >= left.length || i >= right.length) push(pointer(path, i));
        else walk(left[i], right[i], pointer(path, i));
      }
    } else if (plainObject(left) && plainObject(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) push(pointer(path, key));
        else walk(left[key], right[key], pointer(path, key));
      }
    } else if (firstDifference(left, right)) push(path);
  };
  walk(a, b, '');
  return { paths, pathsComplete: complete };
}

/** `$`, `.name`, `['name']`/`["name"]`, `[N]` → JSON pointer keys; null when not of that form. */
export function jsonPathKeys(path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return null;
  const keys = [];
  let rest = path.slice(1);
  while (rest.length) {
    const match = /^\.([A-Za-z_$][\w$-]*)/.exec(rest) ?? /^\[(\d+)\]/.exec(rest) ?? /^\['([^']*)'\]/.exec(rest) ?? /^\["([^"]*)"\]/.exec(rest);
    if (!match) return null;
    keys.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return keys;
}

const jsonPointer = path => jsonPathKeys(path).reduce(pointer, '');
const under = (path, prefix) => path === prefix || path.startsWith(prefix + '/');
const escape = text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
const glob = (pattern, text, segment = false) => typeof text === 'string'
  && new RegExp(`^${pattern.split('*').map(escape).join(segment ? '[^/]*' : '.*')}$`).test(text);

const MASK = '\u0000rust-fix';
function masked(text, paths) {
  let value;
  try { value = parseExact(text); } catch { return null; }
  for (const keys of paths) {
    if (!keys.length) return MASK;
    let parent = value;
    for (const key of keys.slice(0, -1)) parent = parent !== null && typeof parent === 'object' ? parent[key] : undefined;
    if (parent !== null && typeof parent === 'object' && !JSON.isRawJSON(parent)) parent[keys.at(-1)] = MASK;
  }
  return value;
}

/** Differing places of one difference record; null when they are not completely known. */
function places(difference) {
  const listed = difference.pathsComplete === true && Array.isArray(difference.paths) && difference.paths.length > 0;
  switch (difference.kind) {
    case 'outcome':
      return listed ? difference.paths.map(path => ({ surface: 'ipc', command: difference.command, path })) : null;
    case 'outcome-kind':
    case 'expectation':
      return [{ surface: 'ipc', command: difference.command, path: null }];
    case 'events':
      if (!listed || !Array.isArray(difference.eventNames)) return null;
      return difference.paths.map(path => {
        const index = path.split('/')[1];
        const names = difference.eventNames.find(item => String(item.index) === index);
        return { surface: 'event', index, path, names: names ? [names.A, names.B].filter(name => name !== null && name !== undefined) : [] };
      });
    case 'database':
    case 'final-database': {
      const sample = difference.sample;
      if (!Array.isArray(sample) || !sample.length || sample.length !== difference.count) return null;
      return sample.map(row => ({ surface: 'row', row }));
    }
    default:
      return null;
  }
}

function schemaTables(row) {
  const map = list => new Map((Array.isArray(list) ? list : []).map(item => [
    `${item.type}\u0000${item.name}\u0000${item.tbl_name}`,
    { tbl_name: item.tbl_name, sql: item.sql ?? null },
  ]));
  const before = map(row.before), after = map(row.after);
  const tables = new Set();
  for (const [key, item] of before) {
    const other = after.get(key);
    if (!other || other.sql !== item.sql) tables.add(item.tbl_name);
  }
  for (const [key, item] of after) {
    if (!before.has(key)) tables.add(item.tbl_name);
  }
  return [...tables];
}

function columnNames(row) {
  const map = list => new Map((Array.isArray(list) ? list : []).map(item => [item.name, JSON.stringify(item)]));
  const before = map(row.before), after = map(row.after);
  const columns = new Set();
  for (const [name, serialized] of before) {
    if (after.get(name) !== serialized) columns.add(name);
  }
  for (const [name] of after) {
    if (!before.has(name)) columns.add(name);
  }
  return [...columns];
}

function rowCovered(selectors, row) {
  if (row.kind === 'database') return selectors.some(selector => selector.surface === 'fs' && glob(selector.path, row.db, true));
  if (row.kind === 'schema') {
    const tables = schemaTables(row);
    return tables.length > 0 && tables.every(table => selectors.some(selector => selector.surface === 'db'
      && selector.jsonPath === undefined && glob(selector.table, table)));
  }
  if (row.kind === 'table') {
    return typeof row.table === 'string' && selectors.some(selector => selector.surface === 'db'
      && selector.jsonPath === undefined && glob(selector.table, row.table));
  }
  if (row.kind === 'column') {
    const columns = columnNames(row);
    return typeof row.table === 'string' && columns.length > 0 && columns.every(column => selectors.some(selector => selector.surface === 'db'
      && selector.jsonPath === undefined && glob(selector.table, row.table) && glob(selector.column, column)));
  }
  if (!['value', 'storageClass'].includes(row.kind)) return false;
  const matching = selectors.filter(selector => selector.surface === 'db' && glob(selector.table, row.table) && glob(selector.column, row.column));
  if (!matching.length) return false;
  if (matching.some(selector => selector.jsonPath === undefined)) return true;
  const texts = [row.before, row.after].map(cell => cell?.storageClass === 'text' && typeof cell.value === 'string' ? cell.value : null);
  if (row.kind !== 'value' || texts.includes(null)) return false;
  const paths = matching.map(selector => jsonPathKeys(selector.jsonPath));
  const [before, after] = texts.map(text => masked(text, paths));
  return before !== null && after !== null && !firstDifference(before, after);
}

function placeCovered(selectors, place) {
  if (place.surface === 'row') return rowCovered(selectors, place.row);
  if (place.surface === 'ipc') {
    return selectors.some(selector => selector.surface === 'ipc' && glob(selector.command, place.command)
      && (selector.jsonPath === undefined || (place.path !== null && under(place.path, jsonPointer(selector.jsonPath)))));
  }
  return place.names.length > 0 && selectors.some(selector => selector.surface === 'event' && place.names.every(name => glob(selector.event, name))
    && (selector.jsonPath === undefined || under(place.path, `/${place.index}${jsonPointer(selector.jsonPath)}`)));
}

/** Do the selectors of one entry together cover every differing place of this G3 difference record? */
export function entryCovers(selectors, difference, scenarioId) {
  const applicable = selectors.filter(selector => glob(selector.scenario, scenarioId));
  if (!applicable.length) return false;
  const list = places(difference);
  return Boolean(list?.length) && list.every(place => placeCovered(applicable, place));
}

/** Does `selector` alone cover every differing place of this G3 difference record? */
export const selectorCovers = (selector, difference, scenarioId) => entryCovers([selector], difference, scenarioId);

// Width rules follow scripts/electron-migration/gate-checks/rust-fixes.schema.json (the gate is
// the format authority); in addition G3 must be able to evaluate every jsonPath.
export function selectorProblem(selector) {
  if (!plainObject(selector)) return 'selector is not an object';
  const unknown = Object.keys(selector).filter(key => !SELECTOR_KEYS.includes(key));
  if (unknown.length) return `unknown selector field(s) ${unknown.join(', ')}`;
  if (typeof selector.scenario !== 'string' || !selector.scenario) return 'selector lacks scenario';
  const required = SURFACES[selector.surface];
  if (!required) return `selector surface must be one of ${Object.keys(SURFACES).join(', ')}`;
  for (const field of required) {
    if (typeof selector[field] !== 'string' || !selector[field]) return `${selector.surface} selector needs ${field}`;
    if (field !== 'column' && /^\*+$/.test(selector[field])) return `${selector.surface} selector ${field} must not be only a wildcard`;
  }
  const foreign = Object.values(SURFACES).flat().filter(field => !required.includes(field) && selector[field] !== undefined);
  if (foreign.length) return `${selector.surface} selector must not have ${foreign.join(', ')}`;
  if (selector.jsonPath !== undefined && (selector.surface === 'fs' || !jsonPathKeys(selector.jsonPath)?.length)) {
    return `selector jsonPath ${JSON.stringify(selector.jsonPath)} is not a field path G3 can evaluate ($.name / ['name'] / [N])`;
  }
  if (selector.scenario === '*' && selector.surface === 'db' && selector.jsonPath === undefined && selector.column.includes('*')) {
    return 'scenario * db selector needs a jsonPath or a column without wildcard (too broad)';
  }
  return null;
}

export function entryProblem(entry, name) {
  if (!plainObject(entry)) return 'not a JSON object';
  if (typeof entry.id !== 'string' || !/^RF-[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.id)) return 'id must look like RF-<lane>-<slug>';
  if (`${entry.id}.json` !== name) return `id ${entry.id} does not match the file name`;
  if (!KINDS.includes(entry.kind)) return `kind must be one of ${KINDS.join(', ')}`;
  if (!STATUSES.includes(entry.status)) return `status must be one of ${STATUSES.join(', ')}`;
  if (entry.status === 'approved' && (typeof entry.approvedBy !== 'string' || !entry.approvedBy || typeof entry.approvedAt !== 'string' || !entry.approvedAt)) {
    return 'approved without approvedBy/approvedAt';
  }
  if (!plainObject(entry.g3) || typeof entry.g3.affects !== 'boolean' || !Array.isArray(entry.g3.selectors)) return 'g3 must be {affects, selectors[]}';
  if (!entry.g3.affects && entry.g3.selectors.length) return 'g3.affects false with selectors';
  if (entry.g3.affects && !entry.g3.selectors.length) return 'g3.affects true without selectors';
  for (const [index, selector] of entry.g3.selectors.entries()) {
    const problem = selectorProblem(selector);
    if (problem) return `g3.selectors[${index}]: ${problem}`;
  }
  return null;
}

/** Registrations under `root`: applicable entries, named problems, and the hashed source. */
export function loadRustFixes(root, dir = RUST_FIXES_DIR) {
  const absolute = join(root, dir);
  const names = existsSync(absolute) ? readdirSync(absolute).filter(name => /^RF-.*\.json$/.test(name)).sort() : [];
  const entries = [], problems = [], files = [], seen = new Map();
  for (const name of names) {
    const file = `${dir}/${name}`;
    const bytes = readFileSync(join(absolute, name));
    files.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
    let entry;
    try { entry = JSON.parse(bytes.toString('utf8')); } catch (error) {
      problems.push({ file, message: `not JSON: ${error.message}` });
      continue;
    }
    const problem = entryProblem(entry, name) ?? (seen.has(entry.id) ? `duplicate id (also ${seen.get(entry.id)})` : null);
    if (problem) problems.push({ file, message: problem });
    else {
      seen.set(entry.id, file);
      entries.push({ ...entry, file });
    }
  }
  const sha256 = createHash('sha256').update(stringifyExact(files)).digest('hex');
  return { entries, problems, source: { dir, files, sha256 } };
}

function partitionDatabaseGroups(difference) {
  if (!['database', 'final-database'].includes(difference.kind)) return null;
  const sample = difference.sample;
  if (!Array.isArray(sample) || !sample.length || sample.length !== difference.count) return null;
  const groups = new Map();
  for (const row of sample) {
    const tableKey = row.kind === 'schema'
      ? (() => { const tables = schemaTables(row); return tables.length === 1 ? tables[0] : `\u0000schema:${tables.join(',')}`; })()
      : (row.table ?? '');
    const key = `${row.db ?? ''}\u0000${tableKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups.size > 1 ? [...groups.values()].map(rows => ({ ...difference, count: rows.length, sample: rows })) : null;
}

/** First applicable registration covering the difference: approved before proposed, file order within. */
export function rustFixHits(fixes, difference, scenarioId) {
  const hits = { approved: null, proposed: [] };
  for (const entry of fixes?.entries ?? []) {
    if (!entry.g3?.affects || !entryCovers(entry.g3.selectors, difference, scenarioId)) continue;
    if (entry.status === 'approved') hits.approved ??= entry;
    else hits.proposed.push(entry);
  }
  if (!hits.approved) {
    const groups = partitionDatabaseGroups(difference);
    if (groups) {
      const groupHits = groups.map(group => rustFixHits(fixes, group, scenarioId));
      if (groupHits.every(item => item.approved)) hits.approved = groupHits[0].approved;
    }
  }
  return hits;
}

/** Strip table groups already covered by an approved rust-fixes/ registration from a multi-table DB difference. */
export function stripApprovedRustFixRows(fixes, difference, scenarioId) {
  const groups = partitionDatabaseGroups(difference);
  if (!groups) return difference;
  const remaining = groups
    .filter(group => !rustFixHits(fixes, group, scenarioId).approved)
    .flatMap(group => group.sample);
  return remaining.length > 0 && remaining.length < difference.sample.length
    ? { ...difference, count: remaining.length, sample: remaining }
    : difference;
}
