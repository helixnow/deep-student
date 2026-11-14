import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkTrees, diffSnapshots, GOLDEN_DIR, loadGoldenDir, loadGoldenRef, run, validateOwnerMoves,
} from '../slot-owner-moves.mjs';

const root = path.resolve(__dirname, '../../..');
const scenario = { platform: 'desktop', mode: 'prod', shell: 'normal', uiLab: false };
const tempDirs: string[] = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-owner-moves-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Entry {
  id: string;
  key: string | null;
  order: number;
  owner: string;
  origin: string;
  value: unknown;
}

/** One nav entry per snapshot, shaped like the real capture. */
function snapshot(owner: string, entry: Partial<Entry> = {}, plugins: string[] = [owner]) {
  const row: Entry = { id: 'stats', key: null, order: 10, owner, origin: 'builtin', value: { labelKey: 'a:b', icon: '<StatsIcon>' }, ...entry };
  return {
    scenario,
    plugins,
    slots: { nav: { cardinality: 'list', entries: [row] } },
    adapters: { commands: [{ id: 'stats.open', title: 'Stats' }] },
    consumers: { views: [{ key: 'stats', visible: true, navigable: true }] },
  };
}

describe('slot-owner-moves: owner-only comparison', () => {
  it('accepts an owner change only when owner-moves.json lists it', () => {
    const before = snapshot('dstu.ui.shell');
    const after = snapshot('dstu.review');
    expect(diffSnapshots(before, after).failures).toEqual([
      'plugins: ["dstu.ui.shell"] → ["dstu.review"]',
      'nav/stats: owner dstu.ui.shell → dstu.review (not in owner-moves.json)',
    ]);
    const accepted = diffSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]);
    expect(accepted.failures).toEqual([]);
    expect(accepted.acceptedMoves).toEqual(['nav/stats: dstu.ui.shell → dstu.review']);
    expect(accepted.usedMoves).toEqual([0]);
  });

  it('accepts a slot-wide move only from the listed owner', () => {
    const before = snapshot('dstu.ui.shell');
    const after = snapshot('dstu.review');
    expect(diffSnapshots(before, after, [{ slot: 'nav', id: '*', from: 'dstu.ui.shell', to: 'dstu.review' }]).failures).toEqual([]);
    expect(diffSnapshots(before, after, [{ slot: 'nav', id: '*', from: 'dstu.ui.other', to: 'dstu.review' }]).failures)
      .toContain('nav/stats: owner dstu.ui.shell → dstu.review (not in owner-moves.json)');
  });

  it('fails on every non-owner field that changes with a listed move', () => {
    const before = snapshot('dstu.ui.shell');
    const after = snapshot('dstu.review', { key: 'other', order: 20, origin: 'community', value: { labelKey: 'a:c', icon: '<Other>' } });
    const { failures } = diffSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]);
    expect(failures).toEqual(expect.arrayContaining([
      'nav/stats: key null → "other"',
      'nav/stats: order 10 → 20',
      'nav/stats: origin "builtin" → "community"',
      'nav/stats: value.labelKey: "a:b" → "a:c"',
      'nav/stats: value.icon: "<StatsIcon>" → "<Other>"',
    ]));
  });

  it('fails on scenario, plugins, adapters and consumers that change', () => {
    const before = snapshot('dstu.ui.shell');
    const after = {
      ...snapshot('dstu.review'),
      scenario: { ...scenario, platform: 'mobile' },
      plugins: ['dstu.review', 'dstu.extra'],
      adapters: { commands: [{ id: 'stats.open', title: 'Statistics' }] },
      consumers: { views: [{ key: 'stats', visible: false, navigable: true }] },
    };
    const { failures } = diffSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]);
    expect(failures).toEqual(expect.arrayContaining([
      'scenario: {"platform":"desktop","mode":"prod","shell":"normal","uiLab":false} → {"platform":"mobile","mode":"prod","shell":"normal","uiLab":false}',
      'plugins: ["dstu.ui.shell"] → ["dstu.review","dstu.extra"]',
      'adapters.commands[0].title: "Stats" → "Statistics"',
      'consumers.views[0].visible: true → false',
    ]));
  });

  it('ignores the plugins entry of the moving owner itself', () => {
    const before = snapshot('dstu.ui.shell', {}, ['dstu.ui.shell', 'dstu.ui.other']);
    const after = snapshot('dstu.review', {}, ['dstu.review', 'dstu.ui.other']);
    expect(diffSnapshots(before, after, [{ slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' }]).failures).toEqual([]);
  });

  it('accepts a new entry only when listed by exact id and owner', () => {
    const before = snapshot('dstu.ui.shell');
    const after = snapshot('dstu.ui.shell');
    after.slots = { nav: { cardinality: 'list', entries: [...before.slots.nav.entries, { id: 'review', key: null, order: 20, owner: 'dstu.review', origin: 'builtin', value: { labelKey: 'r:title' } }] } };
    expect(diffSnapshots(before, after).failures).toContain('slot nav: added review');
    expect(diffSnapshots(before, after, [{ slot: 'nav', id: '*', from: null, to: 'dstu.review' }]).failures).toContain('slot nav: added review');
    expect(diffSnapshots(before, after, [{ slot: 'nav', id: 'review', from: null, to: 'dstu.shell' }]).failures).toContain('slot nav: added review');
    const accepted = diffSnapshots(before, after, [{ slot: 'nav', id: 'review', from: null, to: 'dstu.review' }]);
    expect(accepted.failures).toEqual([]);
    expect(accepted.acceptedMoves).toEqual(['nav/review: added by dstu.review']);
  });

  it('fails on removed entries, added slots and changed order', () => {
    const before = snapshot('dstu.ui.shell');
    before.slots = { nav: { cardinality: 'list', entries: [before.slots.nav.entries[0], { id: 'media', key: null, order: 30, owner: 'dstu.ui.shell', origin: 'builtin', value: null }] } };
    const after = snapshot('dstu.ui.shell');
    expect(diffSnapshots(before, after).failures).toContain('slot nav: removed media');

    const addedSlot = { ...after, slots: { ...after.slots, extra: { cardinality: 'list', entries: [] } } };
    expect(diffSnapshots(after, addedSlot).failures).toContain('slot extra: added');
    expect(diffSnapshots(addedSlot, after).failures).toContain('slot extra: removed');
  });
});

describe('slot-owner-moves: owner-moves.json validation', () => {
  it('accepts the documented shapes', () => {
    expect(validateOwnerMoves([
      { slot: 'nav', id: 'todo', from: 'dstu.ui.shell', to: 'dstu.todo', note: 'W39' },
      { slot: 'nav', id: '*', from: 'dstu.ui.shell', to: 'dstu.chat' },
      { slot: 'chat.toolResults', id: 'x', from: null, to: 'dstu.ui.chat' },
    ]).problems).toEqual([]);
  });

  it('rejects malformed entries, self moves, wildcard additions and conflicting duplicates', () => {
    const { problems } = validateOwnerMoves([
      null,
      { slot: '', id: 'a', from: 'x', to: 'y' },
      { slot: 'nav', id: 'a', from: 'x' },
      { slot: 'nav', id: 'a', from: 1, to: 'y' },
      { slot: 'nav', id: 'a', from: 'x', to: 'x' },
      { slot: 'nav', id: '*', from: null, to: 'y' },
      { slot: 'nav', id: 'a', from: 'x', to: 'y', note: 7 },
      { slot: 'nav', id: 'a', from: 'x', to: 'y', extra: true },
      { slot: 'nav', id: 'b', from: 'x', to: 'y' },
      { slot: 'nav', id: 'b', from: 'x', to: 'z' },
      { slot: 'nav', id: 'c', from: 'x', to: 'y' },
      { slot: 'nav', id: 'c', from: 'x', to: 'y' },
    ]);
    expect(problems).toEqual(expect.arrayContaining([
      'owner-moves.json[0] must be an object',
      'owner-moves.json[1].slot must be a non-empty string',
      'owner-moves.json[2].to must be a non-empty string',
      'owner-moves.json[3].from must be a non-empty string or null',
      'owner-moves.json[4] moves x to itself',
      'owner-moves.json[5] cannot add every id ("*") at once',
      'owner-moves.json[6].note must be a string',
      'owner-moves.json[7] has unknown fields extra',
      'owner-moves.json[9] conflicts with owner-moves.json[8]: nav/b moves from x to both y and z',
      'owner-moves.json[11] duplicates owner-moves.json[10]',
    ]));
    expect(validateOwnerMoves({}).problems).toEqual(['owner-moves.json must be an array']);
  });
});

describe('slot-owner-moves: trees', () => {
  const move = { slot: 'nav', id: 'stats', from: 'dstu.ui.shell', to: 'dstu.review' };

  it('passes only when every scenario differs by listed owner moves alone', () => {
    const before = { 'desktop-prod-normal-uilab-off': snapshot('dstu.ui.shell') };
    const after = { 'desktop-prod-normal-uilab-off': snapshot('dstu.review') };
    expect(checkTrees(before, after, [move])).toEqual({
      failures: [], acceptedMoves: ['scenario desktop-prod-normal-uilab-off: nav/stats: dstu.ui.shell → dstu.review'],
      unusedMoves: [], scenarios: ['desktop-prod-normal-uilab-off'],
    });
  });

  it('fails on unused moves, missing baselines and dropped scenarios', () => {
    const before = { a: snapshot('dstu.ui.shell') };
    const after = { a: snapshot('dstu.ui.shell'), b: snapshot('dstu.ui.shell') };
    const result = checkTrees(before, after, [move]);
    expect(result.failures).toEqual(expect.arrayContaining([
      'scenario b: no baseline snapshot (a new scenario needs its own before/after evidence)',
      'unused owner move nav/stats: dstu.ui.shell → dstu.review',
    ]));
    expect(checkTrees(before, after, [move], { allowUnused: true }).failures)
      .toEqual(['scenario b: no baseline snapshot (a new scenario needs its own before/after evidence)']);
    expect(checkTrees(after, before, []).failures).toEqual(['scenario b: dropped from the after tree']);
  });

  it('reads two directories and the default moves file', () => {
    const dir = tempDir();
    const beforeDir = path.join(dir, 'before');
    const afterDir = path.join(dir, 'after');
    fs.mkdirSync(beforeDir);
    fs.mkdirSync(afterDir);
    fs.writeFileSync(path.join(beforeDir, 'scene.json'), JSON.stringify(snapshot('dstu.ui.shell')));
    fs.writeFileSync(path.join(afterDir, 'scene.json'), JSON.stringify(snapshot('dstu.review')));
    fs.writeFileSync(path.join(afterDir, 'owner-moves.json'), JSON.stringify([move]));
    expect(run({ rootDir: dir, before: 'before', after: 'after' }).failures).toEqual([]);

    fs.writeFileSync(path.join(afterDir, 'owner-moves.json'), JSON.stringify([]));
    expect(run({ rootDir: dir, before: 'before', after: 'after' }).failures).toEqual([
      'scenario scene: plugins: ["dstu.ui.shell"] → ["dstu.review"]',
      'scenario scene: nav/stats: owner dstu.ui.shell → dstu.review (not in owner-moves.json)',
    ]);
  });

  it('reads the checked-in baseline through git without a checkout', () => {
    expect(loadGoldenRef('HEAD', GOLDEN_DIR)).toEqual(loadGoldenDir(path.join(root, GOLDEN_DIR)));
  });

  it('validates the repository owner-moves.json when one is checked in', () => {
    const file = path.join(root, GOLDEN_DIR, 'owner-moves.json');
    if (!fs.existsSync(file)) return;
    expect(validateOwnerMoves(JSON.parse(fs.readFileSync(file, 'utf8'))).problems).toEqual([]);
  });
});
