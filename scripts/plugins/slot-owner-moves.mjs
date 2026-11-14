#!/usr/bin/env node
/**
 * W39 evidence: a slot-snapshot owner move changes the owner and nothing else.
 *
 *   node scripts/plugins/slot-owner-moves.mjs --before-ref e73e0d98
 *   node scripts/plugins/slot-owner-moves.mjs --before <dir> [--after <dir>] [--moves <file>]
 *   node scripts/plugins/slot-owner-moves.mjs --before-ref <rev> --json
 *
 * Compares the slot-snapshot goldens of two trees (a directory or a git revision) and accepts exactly the drift
 * `owner-moves.json` lists: an entry's owner changes, or a new entry is added under a listed id and owner. Every
 * other field (scenario, plugin list, slot set/cardinality/order, key, order, origin, value, adapters, consumers)
 * must stay byte-identical. Listed moves that no scenario uses fail too, so the file cannot claim moves the tree
 * does not make; `--allow-unused` reports them without failing.
 *
 * This is the before/after form of the comparison in src/ui-plugins/testing/slot-snapshot.ts. The checked-in
 * `node script/plugins/slot-snapshot.mjs --check` compares the current capture with the current goldens and uses
 * the same owner-moves.json; this script proves a rewrite against the baseline tree it started from.
 *
 * Exit codes: 0 only owner moves, 1 drift or an invalid/unsatisfied move list, 2 usage error.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const GOLDEN_DIR = 'tests/visual/__golden__/slots';
export const MOVES_FILE = `${GOLDEN_DIR}/owner-moves.json`;
const IDENTITY_FIELDS = ['key', 'order', 'origin'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const stable = (value) => JSON.stringify(value) ?? 'undefined';

// ------------------------------------------------------------------ owner-moves.json

/**
 * Structural validation. Returns `{ moves, problems }`; `moves` keeps the input order and `note` when present so a
 * report can point at the reviewed entry. Conflicts (the same slot/id/from moving to two owners) are problems too:
 * such a list cannot say what the snapshots are supposed to become.
 */
export function validateOwnerMoves(value) {
  if (!Array.isArray(value)) return { moves: [], problems: ['owner-moves.json must be an array'] };
  const problems = [];
  const moves = [];
  const byKey = new Map();
  value.forEach((raw, index) => {
    const at = `owner-moves.json[${index}]`;
    if (!isObject(raw)) {
      problems.push(`${at} must be an object`);
      return;
    }
    const extra = Object.keys(raw).filter((key) => !['slot', 'id', 'from', 'to', 'note'].includes(key));
    if (extra.length) problems.push(`${at} has unknown fields ${extra.join(', ')}`);
    if (typeof raw.slot !== 'string' || !raw.slot) problems.push(`${at}.slot must be a non-empty string`);
    if (typeof raw.id !== 'string' || !raw.id) problems.push(`${at}.id must be a non-empty string`);
    if (typeof raw.to !== 'string' || !raw.to) problems.push(`${at}.to must be a non-empty string`);
    if (raw.from !== null && (typeof raw.from !== 'string' || !raw.from)) {
      problems.push(`${at}.from must be a non-empty string or null`);
    }
    if (raw.from === null && raw.id === '*') problems.push(`${at} cannot add every id ("*") at once`);
    if (typeof raw.from === 'string' && raw.from === raw.to) problems.push(`${at} moves ${raw.from} to itself`);
    if (raw.note !== undefined && typeof raw.note !== 'string') problems.push(`${at}.note must be a string`);
    if (typeof raw.slot !== 'string' || typeof raw.id !== 'string' || typeof raw.to !== 'string'
        || (raw.from !== null && typeof raw.from !== 'string')) return;
    const move = { slot: raw.slot, id: raw.id, from: raw.from, to: raw.to, ...(raw.note === undefined ? {} : { note: raw.note }) };
    moves.push(move);
    const key = `${move.slot}\u0000${move.from}\u0000${move.id}`;
    const previous = byKey.get(key);
    if (previous && previous.to !== move.to) {
      problems.push(`${at} conflicts with owner-moves.json[${previous.index}]: ${move.slot}/${move.id} moves from ${move.from} to both ${previous.to} and ${move.to}`);
    } else if (previous) {
      problems.push(`${at} duplicates owner-moves.json[${previous.index}]`);
    } else {
      byKey.set(key, { index, to: move.to });
    }
  });
  return { moves, problems };
}

// ------------------------------------------------------------------ JSON diff

/** Leaf differences with JSON-ish paths, at most `limit` of them (same wording as slot-snapshot.ts). */
export function diffJson(pathName, before, after, out, limit = 20) {
  if (out.length >= limit || stable(before) === stable(after)) return;
  const bothArrays = Array.isArray(before) && Array.isArray(after);
  const bothObjects = isObject(before) && isObject(after);
  if (bothArrays) {
    for (let i = 0; i < Math.max(before.length, after.length); i++) diffJson(`${pathName}[${i}]`, before[i], after[i], out, limit);
    return;
  }
  if (bothObjects) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) diffJson(`${pathName}.${key}`, before[key], after[key], out, limit);
    return;
  }
  out.push(`${pathName}: ${stable(before)} → ${stable(after)}`);
}

const moveFor = (moves, slot, id, from) => moves.find((move) => move.slot === slot && move.from === from && (move.id === id || move.id === '*'));
const additionFor = (moves, slot, id) => moves.find((move) => move.slot === slot && move.id === id && move.from === null);

/**
 * The before/after comparison. `moves` is the validated list; the returned `usedMoves` are indexes into it.
 * Kept deliberately in lockstep with diffSlotSnapshots in src/ui-plugins/testing/slot-snapshot.ts: owners may move
 * only through the list, additions only through an exact id, and every remaining field must match.
 */
export function diffSnapshots(before, after, moves = []) {
  const failures = [];
  const acceptedMoves = [];
  const usedMoves = new Set();
  const useMove = (move) => {
    const index = moves.indexOf(move);
    if (index >= 0) usedMoves.add(index);
  };
  if (stable(before.scenario) !== stable(after.scenario)) failures.push(`scenario: ${stable(before.scenario)} → ${stable(after.scenario)}`);
  const owners = new Set(moves.flatMap((move) => [move.from, move.to]).filter((owner) => owner !== null));
  const plugins = (list) => list.filter((id) => !owners.has(id));
  if (stable(plugins(before.plugins ?? [])) !== stable(plugins(after.plugins ?? []))) {
    failures.push(`plugins: ${stable(before.plugins)} → ${stable(after.plugins)}`);
  }
  const beforeSlots = isObject(before.slots) ? before.slots : {};
  const afterSlots = isObject(after.slots) ? after.slots : {};
  for (const slot of new Set([...Object.keys(beforeSlots), ...Object.keys(afterSlots)])) {
    const from = beforeSlots[slot];
    const to = afterSlots[slot];
    if (!from || !to) {
      failures.push(`slot ${slot}: ${from ? 'removed' : 'added'}`);
      continue;
    }
    if (!isObject(from) || !Array.isArray(from.entries) || !isObject(to) || !Array.isArray(to.entries)) {
      failures.push(`slot ${slot}: malformed snapshot (cardinality/entries)`);
      continue;
    }
    if (from.cardinality !== to.cardinality) failures.push(`slot ${slot}: cardinality ${from.cardinality} → ${to.cardinality}`);
    const beforeIds = from.entries.map((entry) => entry?.id);
    const afterIds = to.entries.map((entry) => entry?.id);
    const removed = beforeIds.filter((id) => !afterIds.includes(id));
    if (removed.length) failures.push(`slot ${slot}: removed ${removed.join(', ')}`);
    const unlisted = [];
    for (const id of afterIds.filter((id) => !beforeIds.includes(id))) {
      const owner = to.entries.find((entry) => entry.id === id)?.owner;
      const addition = additionFor(moves, slot, id);
      if (addition && addition.to === owner) {
        acceptedMoves.push(`${slot}/${id}: added by ${owner}`);
        useMove(addition);
      } else {
        unlisted.push(id);
      }
    }
    if (unlisted.length) failures.push(`slot ${slot}: added ${unlisted.join(', ')}`);
    const common = afterIds.filter((id) => beforeIds.includes(id));
    const beforeCommon = beforeIds.filter((id) => afterIds.includes(id));
    if (stable(common) !== stable(beforeCommon)) failures.push(`slot ${slot}: sequence ${beforeCommon.join(' > ')} → ${common.join(' > ')}`);
    for (const id of common) {
      const entryBefore = from.entries.find((entry) => entry.id === id);
      const entryAfter = to.entries.find((entry) => entry.id === id);
      if (entryBefore.owner !== entryAfter.owner) {
        const move = moveFor(moves, slot, id, entryBefore.owner);
        if (move && move.to === entryAfter.owner) {
          acceptedMoves.push(`${slot}/${id}: ${entryBefore.owner} → ${entryAfter.owner}`);
          useMove(move);
        } else {
          failures.push(`${slot}/${id}: owner ${entryBefore.owner} → ${entryAfter.owner} (not in owner-moves.json)`);
        }
      }
      for (const field of IDENTITY_FIELDS) {
        if (entryBefore[field] !== entryAfter[field]) failures.push(`${slot}/${id}: ${field} ${stable(entryBefore[field])} → ${stable(entryAfter[field])}`);
      }
      diffJson(`${slot}/${id}: value`, entryBefore.value, entryAfter.value, failures, failures.length + 20);
    }
  }
  diffJson('adapters', before.adapters, after.adapters, failures, failures.length + 20);
  diffJson('consumers', before.consumers, after.consumers, failures, failures.length + 20);
  return { failures, acceptedMoves, usedMoves: [...usedMoves].sort((a, b) => a - b) };
}

// ------------------------------------------------------------------ trees

/** `{ scenario: snapshot }` from a golden directory. `owner-moves.json` is not a snapshot. */
export function loadGoldenDir(dir) {
  const snapshots = {};
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json') && name !== 'owner-moves.json').sort()) {
    snapshots[file.replace(/\.json$/, '')] = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
  return snapshots;
}

/** The same map, read with `git show` (no checkout) from `<rev>:<dir>`. */
export function loadGoldenRef(rev, dir, { cwd = root } = {}) {
  const listed = execFileSync('git', ['ls-tree', '--name-only', rev, '--', `${dir}/`], { cwd, encoding: 'utf8' })
    .split('\n').filter((name) => name.endsWith('.json') && !name.endsWith('/owner-moves.json'));
  const snapshots = {};
  for (const file of listed) {
    const name = path.posix.basename(file).replace(/\.json$/, '');
    snapshots[name] = JSON.parse(execFileSync('git', ['show', `${rev}:${file}`], { cwd, encoding: 'utf8', maxBuffer: 64 << 20 }));
  }
  return snapshots;
}

/**
 * Full proof for two trees: scenario sets equal, every snapshot only owner-moved, every listed move used.
 * `before`/`after` are `{ scenario: snapshot }` maps; `moves` is the raw owner-moves.json value.
 */
export function checkTrees(before, after, moves, { allowUnused = false } = {}) {
  const { moves: valid, problems } = validateOwnerMoves(moves);
  const failures = [...problems];
  const acceptedMoves = [];
  const used = new Set();
  const scenarios = Object.keys(after).sort();
  for (const name of scenarios) {
    if (!before[name]) {
      failures.push(`scenario ${name}: no baseline snapshot (a new scenario needs its own before/after evidence)`);
      continue;
    }
    const diff = diffSnapshots(before[name], after[name], valid);
    failures.push(...diff.failures.map((failure) => `scenario ${name}: ${failure}`));
    acceptedMoves.push(...diff.acceptedMoves.map((move) => `scenario ${name}: ${move}`));
    for (const index of diff.usedMoves) used.add(index);
  }
  for (const name of Object.keys(before)) {
    if (!after[name]) failures.push(`scenario ${name}: dropped from the after tree`);
  }
  const unused = valid.map((move, index) => ({ move, index })).filter(({ index }) => !used.has(index));
  const unusedMoves = unused.map(({ move }) => `${move.slot}/${move.id}: ${move.from ?? '(new)'} → ${move.to}${move.note ? ` (${move.note})` : ''}`);
  if (!allowUnused) for (const line of unusedMoves) failures.push(`unused owner move ${line}`);
  return { failures, acceptedMoves, unusedMoves, scenarios };
}

// ------------------------------------------------------------------ CLI

function parseArgs(argv) {
  const options = { before: null, beforeRef: null, after: GOLDEN_DIR, moves: null, json: false, allowUnused: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--before') options.before = argv[++i];
    else if (arg === '--before-ref') options.beforeRef = argv[++i];
    else if (arg === '--after') options.after = argv[++i];
    else if (arg === '--moves') options.moves = argv[++i];
    else if (arg === '--check') continue;
    else if (arg === '--json') options.json = true;
    else if (arg === '--allow-unused') options.allowUnused = true;
    else throw new Error(`unknown argument ${arg}`);
  }
  return options;
}

export function run({ rootDir = root, before, beforeRef, after = GOLDEN_DIR, moves = null, allowUnused = false } = {}) {
  if (!before && !beforeRef) throw new Error('one of --before <dir> or --before-ref <rev> is required');
  const afterDir = path.resolve(rootDir, after);
  const movesFile = path.resolve(rootDir, moves ?? path.join(after, 'owner-moves.json'));
  const movesValue = fs.existsSync(movesFile) ? JSON.parse(fs.readFileSync(movesFile, 'utf8')) : [];
  const beforeTree = beforeRef ? loadGoldenRef(beforeRef, GOLDEN_DIR, { cwd: rootDir }) : loadGoldenDir(path.resolve(rootDir, before));
  const afterTree = loadGoldenDir(afterDir);
  return { movesFile, ...checkTrees(beforeTree, afterTree, movesValue, { allowUnused }) };
}

function main(argv) {
  let result;
  try {
    result = run(parseArgs(argv));
  } catch (error) {
    console.error(`slot-owner-moves: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const move of result.acceptedMoves) console.log(`  ~ ${move}`);
    for (const line of result.unusedMoves) console.log(`  ? unused ${line}`);
    for (const failure of result.failures) console.log(`  ✗ ${failure}`);
    const moves = result.acceptedMoves.length;
    const relative = path.relative(process.cwd(), result.movesFile);
    const shown = relative.startsWith('..') ? result.movesFile : relative || result.movesFile;
    console.log(`slot-owner-moves: ${result.scenarios.length} scenarios, ${moves} accepted owner change${moves === 1 ? '' : 's'}, `
      + `${result.failures.length} failure${result.failures.length === 1 ? '' : 's'} (${shown})`);
  }
  process.exitCode = result.failures.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
