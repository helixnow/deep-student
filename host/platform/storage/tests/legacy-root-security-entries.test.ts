import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { DataSpaceManager } from '../data-space.ts';

const roots: string[] = [];
const noPublication = { recover: async () => {} } as never;

function legacyRoot(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'w07-legacy-security-'));
  roots.push(base);
  fs.writeFileSync(path.join(base, 'mistakes.db'), 'legacy-db');
  fs.writeFileSync(path.join(base, '.master_key'), randomBytes(32).toString('base64'));
  fs.mkdirSync(path.join(base, '.secure'));
  fs.writeFileSync(path.join(base, '.secure', '.key_seed'), 'legacy-seed');
  fs.writeFileSync(path.join(base, '.secure', 'cloud_storage_credentials.enc'), 'cloud');
  fs.writeFileSync(path.join(base, '.secure', 'settings.api_key.enc'), 'settings');
  return base;
}

function tree(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of fs.readdirSync(dir).sort()) out[name] = fs.readFileSync(path.join(dir, name), 'utf8');
  return out;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('legacy root migration keeps security entries at the root and copies them into slotA', () => {
  it('RF-W07-legacy-root-security-entries-copy: pre-slot .master_key and .secure stay at the root and get a slotA copy', () => {
    const base = legacyRoot();
    const rootKey = fs.readFileSync(path.join(base, '.master_key'), 'utf8');
    const rootSecure = tree(path.join(base, '.secure'));
    const manager = new DataSpaceManager(base, noPublication);

    manager.ensureLayout();

    const slotA = manager.slotDir('slotA');
    expect(fs.readFileSync(path.join(slotA, 'mistakes.db'), 'utf8')).toBe('legacy-db');
    expect(fs.existsSync(path.join(base, 'mistakes.db'))).toBe(false);
    expect(fs.readFileSync(path.join(base, '.master_key'), 'utf8')).toBe(rootKey);
    expect(tree(path.join(base, '.secure'))).toEqual(rootSecure);
    expect(fs.readFileSync(path.join(slotA, '.master_key'), 'utf8')).toBe(rootKey);
    expect(tree(path.join(slotA, '.secure'))).toEqual(rootSecure);
    expect(fs.existsSync(manager.legacyCompletePath)).toBe(true);
    expect(fs.existsSync(manager.legacyPendingPath)).toBe(false);
  });

  it('a retried migration replaces a partial slotA copy left by the interrupted attempt', () => {
    const base = legacyRoot();
    const manager = new DataSpaceManager(base, noPublication);
    const slotA = manager.slotDir('slotA');
    fs.mkdirSync(path.join(slotA, '.secure'), { recursive: true });
    fs.writeFileSync(path.join(slotA, '.secure', '.key_seed'), 'leg');
    fs.writeFileSync(manager.legacyPendingPath, '1');

    manager.ensureLayout();

    expect(tree(path.join(slotA, '.secure'))).toEqual(tree(path.join(base, '.secure')));
  });

  it('keeps slotA security entries that an older partial migration already placed there', () => {
    const base = legacyRoot();
    const manager = new DataSpaceManager(base, noPublication);
    const slotA = manager.slotDir('slotA');
    fs.mkdirSync(path.join(slotA, '.secure'), { recursive: true });
    fs.writeFileSync(path.join(slotA, '.secure', '.key_seed'), 'newer-seed');
    fs.writeFileSync(path.join(slotA, '.master_key'), 'newer-key');

    manager.ensureLayout();

    expect(tree(path.join(slotA, '.secure'))).toEqual({ '.key_seed': 'newer-seed' });
    expect(fs.readFileSync(path.join(slotA, '.master_key'), 'utf8')).toBe('newer-key');
  });

  it('a host-created .secure without a seed is not copied into slotA', () => {
    const base = legacyRoot();
    fs.rmSync(path.join(base, '.secure'), { recursive: true });
    fs.mkdirSync(path.join(base, '.secure'));
    const manager = new DataSpaceManager(base, noPublication);

    manager.ensureLayout();

    expect(fs.existsSync(path.join(manager.slotDir('slotA'), '.secure'))).toBe(false);
  });

  it('a slots-era data dir never copies root security entries', () => {
    const base = legacyRoot();
    fs.rmSync(path.join(base, 'mistakes.db'));
    const manager = new DataSpaceManager(base, noPublication);

    manager.ensureLayout();

    expect(fs.existsSync(path.join(manager.slotDir('slotA'), '.secure'))).toBe(false);
    expect(fs.existsSync(path.join(manager.slotDir('slotA'), '.master_key'))).toBe(false);
  });
});
