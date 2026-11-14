/** WP-094 synthetic skill ZIP inputs for L07 skill_import_zip. Constructed bytes, NOT historical A/release artifacts. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

/** Seed-relative HOME. A runner that sets HOME=<copied seed>/home lets scenarios use `~/w0-zip-seeds/<file>`. */
export const SKILL_ZIP_HOME = 'home';
export const SKILL_ZIP_DIR = 'w0-zip-seeds';

export interface SkillZipSeedFile {
  file: string;
  /** Path relative to the seed directory (POSIX). */
  relativePath: string;
  /** Path as a scenario would pass it when HOME is the copied seed's `home/`. */
  homePath: string;
  synthetic: true;
  /** Original Rust branch this input targets (src-tauri/crates/dstu-agent/src/chat_v2/skills.rs). */
  rustBranch: string;
  construction: string;
}

interface Entry { name: string; data?: string | Buffer }
const ascii = (value: string) => Buffer.from(value, 'utf8');
// Fixed DOS 1980-01-01 00:00:00, stored (method 0), no extra fields/comments: no clock or zlib version in the bytes.
const DOS_TIME = 0, DOS_DATE = 0x0021;

function archive(entries: Entry[], options: { dropLastCentral?: boolean } = {}): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = ascii(entry.name);
    if (/[^\x20-\x7e]/.test(entry.name)) throw new Error('Seed entry names stay ASCII so no UTF-8 flag is needed');
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.isBuffer(entry.data) ? entry.data : ascii(entry.data);
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(DOS_TIME, 12); central.writeUInt16LE(DOS_DATE, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.name.endsWith('/') ? 0x10 : 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + data.length;
  }
  const declaredSize = centrals.reduce((sum, c) => sum + c.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(declaredSize, 12); eocd.writeUInt32LE(offset, 16); eocd.writeUInt16LE(0, 20);
  // Truncation keeps the EOCD's declared count/size/offset, but the last central record bytes are gone.
  const written = options.dropLastCentral ? centrals.slice(0, -1) : centrals;
  return Buffer.concat([...locals, ...written, eocd]);
}

const ROOT_SKILL = '---\nname: w0-zip-root\ndescription: X3 synthetic root frontmatter seed\n---\n# Root 技能📚\n';
const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

const SEEDS: { file: string; rustBranch: string; construction: string; bytes: () => Buffer }[] = [
  { file: 'zero-bytes.zip', rustBranch: ':2142 Skill package is empty',
    construction: '0-byte file', bytes: () => Buffer.alloc(0) },
  { file: 'empty-archive.zip', rustBranch: ':1340-1378 preflight returns 0 entries -> :1436-1437 no SKILL.md',
    construction: 'lone 22-byte EOCD, 0 entries', bytes: () => archive([]) },
  { file: 'no-skill-md.zip', rustBranch: ':1436-1437 Zip must contain a SKILL.md',
    construction: 'stored README.md + scripts/run.sh, no SKILL.md anywhere',
    bytes: () => archive([{ name: 'README.md', data: '# no skill\n' }, { name: 'scripts/run.sh', data: '#!/bin/sh\necho hi\n' }]) },
  { file: 'root-frontmatter-name.zip', rustBranch: ':923-924 root prefix imported-skill -> :1520-1523 frontmatter name w0-zip-root',
    construction: 'stored root SKILL.md (name: w0-zip-root) + notes.md',
    bytes: () => archive([{ name: 'SKILL.md', data: ROOT_SKILL }, { name: 'notes.md', data: 'root notes 中文\n' }]) },
  { file: 'root-invalid-frontmatter-name.zip', rustBranch: ':943-973 frontmatter name rejected -> :924 imported-skill kept',
    construction: 'stored root SKILL.md with name "bad name!" (space and !)',
    bytes: () => archive([{ name: 'SKILL.md', data: '---\nname: "bad name!"\ndescription: invalid id\n---\n# Bad\n' }]) },
  { file: 'multi-file-folder.zip', rustBranch: ':926-937 folder prefix w0-zip-multi; skips :1453 dir, :1457 node_modules, :1472-1475 outside prefix',
    construction: 'stored folder package: dir entry, SKILL.md, scripts/, references/, binary asset; outside-prefix and node_modules entries',
    bytes: () => archive([
      { name: 'w0-zip-multi/' },
      { name: 'w0-zip-multi/SKILL.md', data: '---\nname: w0-zip-multi\ndescription: multi file\nallowed-tools:\n  - read_file\n  - list_dir\n---\n# Multi\n' },
      { name: 'w0-zip-multi/scripts/run.sh', data: '#!/bin/sh\necho multi\n' },
      { name: 'w0-zip-multi/references/guide.md', data: '# Guide 指南🧭\n' },
      { name: 'w0-zip-multi/assets/blob.dat', data: ALL_BYTES },
      { name: 'outside.txt', data: 'outside prefix\n' },
      { name: 'w0-zip-multi/node_modules/pkg/index.js', data: 'module.exports = 1;\n' },
    ]) },
  { file: 'duplicate-entry.zip', rustBranch: ':1485-1486 Zip contains duplicate path: notes.md',
    construction: 'two central records with identical name notes.md and different stored bytes',
    bytes: () => archive([{ name: 'SKILL.md', data: ROOT_SKILL }, { name: 'notes.md', data: 'first\n' }, { name: 'notes.md', data: 'second\n' }]) },
  { file: 'case-conflict.zip', rustBranch: ':1485-1486 Zip contains duplicate path (case fold) for references/guide.md',
    construction: 'references/Guide.md and references/guide.md, distinct byte names',
    bytes: () => archive([{ name: 'SKILL.md', data: ROOT_SKILL }, { name: 'references/Guide.md', data: 'upper\n' }, { name: 'references/guide.md', data: 'lower\n' }]) },
  { file: 'not-a-zip.zip', rustBranch: ':1380 Invalid zip: missing end-of-central-directory record',
    construction: '.zip-named plain text (>22 bytes) without any PK signature',
    bytes: () => ascii('this is not a zip archive; it has no end-of-central-directory record\n') },
  { file: 'truncated-central-directory.zip', rustBranch: ':1410 ZipArchive::new Err -> Invalid zip: <zip 0.6.6 message>',
    construction: '3-entry stored archive; last central record removed, EOCD still declares 3 entries and the original CD size/offset',
    bytes: () => archive([{ name: 'SKILL.md', data: ROOT_SKILL }, { name: 'notes.md', data: 'notes\n' }, { name: 'extra.md', data: 'extra\n' }], { dropLastCentral: true }) },
];

export const SKILL_ZIP_SEED_FILES: readonly SkillZipSeedFile[] = SEEDS.map(({ file, rustBranch, construction }) => ({
  file, relativePath: `${SKILL_ZIP_HOME}/${SKILL_ZIP_DIR}/${file}`, homePath: `~/${SKILL_ZIP_DIR}/${file}`,
  synthetic: true, rustBranch, construction,
}));

/** Write all skill ZIP inputs below `<seed directory>/home/w0-zip-seeds/`. */
export function writeSkillZipSeeds(seedDirectory: string): void {
  const target = join(seedDirectory, SKILL_ZIP_HOME, SKILL_ZIP_DIR);
  mkdirSync(target, { recursive: true });
  for (const seed of SEEDS) writeFileSync(join(target, seed.file), seed.bytes(), { flag: 'wx' });
}
