import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, tempDir } from './__fixtures__/fixtures.ts';
import { snapshotDirectory } from './__fixtures__/database-state.ts';
import { copySeed, createSeed, resolveSeed, type SeedDirectory } from './__fixtures__/scenario-seeds.ts';
import { SKILL_ZIP_SEED_FILES } from './__fixtures__/skill-zip-seeds.ts';

// Expected structure is written out here, independent of the builder and of any L07/Rust import result.
const FILES = ['case-conflict.zip', 'duplicate-entry.zip', 'empty-archive.zip', 'multi-file-folder.zip', 'no-skill-md.zip',
  'not-a-zip.zip', 'root-frontmatter-name.zip', 'root-invalid-frontmatter-name.zip', 'truncated-central-directory.zip', 'zero-bytes.zip'];

interface Central { name: string; crc: number; size: number; compressed: number; method: number; external: number; localOffset: number }
interface Parsed { eocdAt: number; total: number; onDisk: number; disk: number; cdDisk: number; cdSize: number; cdOffset: number; centrals: Central[] }

/** Minimal independent reader: one EOCD (no comment), then walk central records until the EOCD. */
function parse(bytes: Buffer): Parsed {
  const eocdAt = bytes.length - 22;
  expect(eocdAt).toBeGreaterThanOrEqual(0);
  expect(bytes.readUInt32LE(eocdAt)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(eocdAt + 20)).toBe(0);
  const parsed: Parsed = { eocdAt, disk: bytes.readUInt16LE(eocdAt + 4), cdDisk: bytes.readUInt16LE(eocdAt + 6),
    onDisk: bytes.readUInt16LE(eocdAt + 8), total: bytes.readUInt16LE(eocdAt + 10),
    cdSize: bytes.readUInt32LE(eocdAt + 12), cdOffset: bytes.readUInt32LE(eocdAt + 16), centrals: [] };
  let at = parsed.cdOffset;
  while (at < eocdAt && bytes.readUInt32LE(at) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    parsed.centrals.push({ method: bytes.readUInt16LE(at + 10), crc: bytes.readUInt32LE(at + 16), compressed: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24), external: bytes.readUInt32LE(at + 38), localOffset: bytes.readUInt32LE(at + 42),
      name: bytes.subarray(at + 46, at + 46 + nameLength).toString('latin1') });
    at += 46 + nameLength + extra + comment;
  }
  expect(at, 'central records end exactly at EOCD').toBe(eocdAt);
  return parsed;
}

function localData(bytes: Buffer, central: Central): Buffer {
  const at = central.localOffset;
  expect(bytes.readUInt32LE(at)).toBe(0x04034b50);
  const nameLength = bytes.readUInt16LE(at + 26), extra = bytes.readUInt16LE(at + 28);
  expect(bytes.subarray(at + 30, at + 30 + nameLength).toString('latin1')).toBe(central.name);
  expect(bytes.readUInt32LE(at + 14)).toBe(central.crc);
  const data = bytes.subarray(at + 30 + nameLength + extra, at + 30 + nameLength + extra + central.compressed);
  expect(central.method, 'stored').toBe(0);
  expect(data.length).toBe(central.size);
  expect(crc32(data) >>> 0, `${central.name} CRC`).toBe(central.crc);
  return data;
}

/** Well-formed: single disk, declared count/size/offset match the real central directory. */
function wellFormed(bytes: Buffer): Parsed {
  const parsed = parse(bytes);
  expect([parsed.disk, parsed.cdDisk]).toEqual([0, 0]);
  expect(parsed.onDisk).toBe(parsed.total);
  expect(parsed.centrals).toHaveLength(parsed.total);
  expect(parsed.cdOffset + parsed.cdSize).toBe(parsed.eocdAt);
  return parsed;
}

async function jszipNames(bytes: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  return Object.keys(zip.files);
}

let root: string, source: SeedDirectory, copies: SeedDirectory[];
const read = (seed: SeedDirectory, file: string) => readFileSync(join(seed.directory, 'home/w0-zip-seeds', file));
beforeAll(() => {
  root = tempDir();
  source = createSeed('skill-zip-v0', join(root, 'catalog'));
  copies = ['A1', 'A2', 'B'].map(side => copySeed('skill-zip-v0', join(root, 'catalog'), join(root, 'run', side)));
});
afterAll(() => { if (root) cleanup(root); });

describe('WP-094 skill-zip-v0 seed', () => {
  it('publishes exact synthetic file names, seed-relative paths and HOME-relative paths via the WP-044 seed API', () => {
    expect(resolveSeed('skill-zip-v0', join(root, 'catalog'))).toEqual(source);
    expect(source).toMatchObject({ name: 'skill-zip-v0', provenance: 'synthetic-zip' });
    expect(readdirSync(source.directory).sort()).toEqual(['app-data', 'home', 'local-data']);
    expect(readdirSync(source.dataDir)).toEqual([]);
    expect(readdirSync(source.dataLocalDir)).toEqual([]);
    expect(readdirSync(join(source.directory, 'home'))).toEqual(['w0-zip-seeds']);
    expect(readdirSync(join(source.directory, 'home/w0-zip-seeds')).sort()).toEqual(FILES);
    expect(SKILL_ZIP_SEED_FILES.map(seed => seed.file).sort()).toEqual(FILES);
    for (const seed of SKILL_ZIP_SEED_FILES) {
      expect(seed).toMatchObject({ synthetic: true, relativePath: `home/w0-zip-seeds/${seed.file}`, homePath: `~/w0-zip-seeds/${seed.file}` });
      expect(seed.rustBranch).toMatch(/^:\d+/);
      expect(seed.construction.length).toBeGreaterThan(0);
      // `~/` is expanded against HOME=<seed>/home by both Rust expand_path and the TS skill files service.
      expect(join(source.directory, 'home', seed.homePath.slice(2))).toBe(join(source.directory, seed.relativePath));
    }
  });

  it('copies to independent A1/A2/B directories byte-for-byte, rebuilds identically and contains no databases', () => {
    const rebuilt = createSeed('skill-zip-v0', join(root, 'rebuild'));
    expect(new Set(copies.map(copy => copy.directory)).size).toBe(3);
    for (const file of FILES) {
      const original = read(source, file);
      expect(read(rebuilt, file).equals(original), `${file} rebuild`).toBe(true);
      for (const copy of copies) expect(read(copy, file).equals(original), `${copy.directory} ${file}`).toBe(true);
    }
    for (const copy of copies) {
      expect(readdirSync(join(copy.directory, 'home/w0-zip-seeds')).sort()).toEqual(FILES);
      expect(snapshotDirectory(copy.directory)).toEqual({ version: 0, databases: {} });
    }
  });

  it('empty inputs: 0-byte file and a lone empty EOCD archive', () => {
    const [b] = copies;
    expect(read(b!, 'zero-bytes.zip').length).toBe(0);
    const empty = read(b!, 'empty-archive.zip');
    expect(empty.length).toBe(22);
    expect(wellFormed(empty)).toMatchObject({ eocdAt: 0, total: 0, cdSize: 0, cdOffset: 0, centrals: [] });
  });

  it('no-skill-md and root frontmatter archives carry the intended entry names and SKILL.md text', async () => {
    const b = copies[2]!;
    const none = read(b, 'no-skill-md.zip');
    const noneNames = wellFormed(none).centrals.map(c => c.name);
    expect(noneNames).toEqual(['README.md', 'scripts/run.sh']);
    expect(noneNames.some(name => /(^|\/)skill\.md$/i.test(name))).toBe(false);
    expect((await jszipNames(none)).sort()).toEqual(['README.md', 'scripts/run.sh']);

    const rootZip = read(b, 'root-frontmatter-name.zip'), rootParsed = wellFormed(rootZip);
    expect(rootParsed.centrals.map(c => c.name)).toEqual(['SKILL.md', 'notes.md']);
    const rootSkill = localData(rootZip, rootParsed.centrals[0]!).toString('utf8').split('\n');
    expect(rootSkill.slice(0, 4)).toEqual(['---', 'name: w0-zip-root', 'description: X3 synthetic root frontmatter seed', '---']);
    expect(localData(rootZip, rootParsed.centrals[1]!).toString('utf8')).toBe('root notes 中文\n');
    expect((await jszipNames(rootZip)).sort()).toEqual(['SKILL.md', 'notes.md']);

    const invalid = read(b, 'root-invalid-frontmatter-name.zip'), invalidParsed = wellFormed(invalid);
    expect(invalidParsed.centrals.map(c => c.name)).toEqual(['SKILL.md']);
    const nameLine = localData(invalid, invalidParsed.centrals[0]!).toString('utf8').split('\n')[1]!;
    expect(nameLine).toBe('name: "bad name!"');
    expect(/^[A-Za-z0-9_-]+$/.test(nameLine.slice(5).trim().replace(/^"|"$/g, ''))).toBe(false);
  });

  it('legal multi-file folder archive: prefix entry, nested files, binary bytes and skip candidates', async () => {
    const bytes = read(copies[1]!, 'multi-file-folder.zip'), parsed = wellFormed(bytes);
    expect(parsed.centrals.map(c => c.name)).toEqual(['w0-zip-multi/', 'w0-zip-multi/SKILL.md', 'w0-zip-multi/scripts/run.sh',
      'w0-zip-multi/references/guide.md', 'w0-zip-multi/assets/blob.dat', 'outside.txt', 'w0-zip-multi/node_modules/pkg/index.js']);
    const [dir, skill, , guide, blob] = parsed.centrals;
    expect(dir).toMatchObject({ size: 0, external: 0x10 });
    expect(localData(bytes, skill!).toString('utf8')).toContain('name: w0-zip-multi\n');
    expect(localData(bytes, guide!).toString('utf8')).toBe('# Guide 指南🧭\n');
    expect([...localData(bytes, blob!)]).toEqual(Array.from({ length: 256 }, (_, i) => i));
    for (const central of parsed.centrals) localData(bytes, central);
    expect((await jszipNames(bytes)).sort()).toEqual(parsed.centrals.map(c => c.name).sort());
  });

  it('conflict archives: exact duplicate central names and a case-fold-only collision', async () => {
    const dup = read(copies[0]!, 'duplicate-entry.zip'), dupParsed = wellFormed(dup);
    expect(dupParsed.centrals.map(c => c.name)).toEqual(['SKILL.md', 'notes.md', 'notes.md']);
    expect(dupParsed.centrals[1]!.localOffset).not.toBe(dupParsed.centrals[2]!.localOffset);
    expect([localData(dup, dupParsed.centrals[1]!).toString(), localData(dup, dupParsed.centrals[2]!).toString()]).toEqual(['first\n', 'second\n']);

    const fold = read(copies[0]!, 'case-conflict.zip'), foldNames = wellFormed(fold).centrals.map(c => c.name);
    expect(foldNames).toEqual(['SKILL.md', 'references/Guide.md', 'references/guide.md']);
    expect(new Set(foldNames).size).toBe(3);
    expect(new Set(foldNames.map(name => name.toLowerCase())).size).toBe(2);
    expect((await jszipNames(fold)).sort()).toEqual(['SKILL.md', 'references/Guide.md', 'references/guide.md']);
  });

  it('corrupt inputs are damaged in the intended metadata, not merely asserted as import errors', () => {
    const notZip = read(copies[1]!, 'not-a-zip.zip');
    expect(notZip.length).toBeGreaterThan(22);
    expect(notZip.includes(Buffer.from('PK\x05\x06', 'latin1'))).toBe(false);
    expect(notZip.includes(Buffer.from('PK', 'latin1'))).toBe(false);

    const truncated = read(copies[1]!, 'truncated-central-directory.zip'), parsed = parse(truncated);
    expect(parsed).toMatchObject({ disk: 0, cdDisk: 0, onDisk: 3, total: 3 });
    expect(parsed.centrals.map(c => c.name)).toEqual(['SKILL.md', 'notes.md']);
    for (const central of parsed.centrals) localData(truncated, central);
    const actualCentralBytes = parsed.eocdAt - parsed.cdOffset;
    // EOCD still declares the untruncated 3-record directory: 46 + "extra.md".length bytes are missing.
    expect(parsed.cdSize - actualCentralBytes).toBe(46 + 'extra.md'.length);
    expect(parsed.cdOffset + parsed.cdSize).toBeGreaterThan(parsed.eocdAt);
    // The removed record's local file still exists, so only the central directory is damaged.
    expect(truncated.subarray(0, parsed.cdOffset).includes(Buffer.from('extra.md'))).toBe(true);
  });
});
