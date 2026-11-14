/**
 * unified_file_manager.rs 读取侧公开面（textbooks_add / read_file_bytes / get_file_size / hash_file 的依赖）。
 * Rust 对这些函数没有单元测试；这里经消费者唯一入口 `api.ts` 做契约测试，断言逐条对照
 * unified_file_manager.rs:206/652/665/677/711/768/979/991/1014 的分支、错误种类与文案。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectExtensionFromMagic,
  extractExtension,
  extractFileName,
  getFileSize,
  hashFileSha256,
  isOpaqueDocumentId,
  readAllBytesBounded,
  resolveFileInfo,
  sanitizeFileNameForFs,
} from '../node.ts';

const dirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-ufm-read-'));
  dirs.push(dir);
  return dir;
}
function file(name: string, content: string | Uint8Array): string {
  const target = path.join(tmp(), name);
  fs.writeFileSync(target, content);
  return target;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** 最小 ZIP Local File Header（未压缩），足够驱动 detect_zip_subtype 的头部扫描。 */
function zipEntry(name: string, data = ''): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const body = Buffer.from(data, 'utf8');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBytes, body]);
}

function thrown(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  throw new Error('expected the call to throw');
}

const VIRTUAL = 'content://com.android.providers.downloads.documents/document/446';

describe('is_opaque_document_id', () => {
  it('matches the documented Android document ids', () => {
    for (const id of ['document:1000019790', 'image:12345', 'msf:62', '446']) expect(isOpaqueDocumentId(id)).toBe(true);
  });
  it('rejects real names, empty suffixes and empty input', () => {
    for (const name of ['', 'file.pdf', 'document:', 'msf:62a', 'primary:Download', '12.5', 'a:1:2']) {
      expect(isOpaqueDocumentId(name)).toBe(false);
    }
  });
});

describe('extract_file_name / extract_extension', () => {
  it('decodes the last content:// document segment and takes its last path component', () => {
    const uri = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2FQuarkDownloads%2Ffile.PDF';
    expect(extractFileName(uri)).toBe('file.PDF');
    expect(extractExtension(uri)).toBe('pdf');
    expect(extractFileName('C:\\Users\\alice\\Documents\\file.pdf')).toBe('file.pdf');
  });
  it('keeps invalid percent escapes literal while decoding valid ones (urlencoding::decode)', () => {
    expect(extractFileName('/dir/100%zz%20a.pdf')).toBe('100%zz a.pdf');
    expect(extractFileName('/dir/a%4%41.txt')).toBe('a%4A.txt');
    // 解码结果不是合法 UTF-8 时整体回退原文
    expect(extractFileName('/dir/bad%FF%20.txt')).toBe('bad%FF%20.txt');
  });
  it('follows Path::extension for dot files and trailing dots', () => {
    expect(extractExtension('/x/.bashrc')).toBeNull();
    expect(extractExtension('/x/name.')).toBeNull();
    expect(extractExtension('/x/..')).toBeNull();
    expect(extractExtension('/x/..tar')).toBe('tar');
    expect(extractExtension('/x/noext')).toBeNull();
  });
});

describe('sanitize_file_name_for_fs', () => {
  it('replaces : ? * " < > | NUL and control characters with _', () => {
    expect(sanitizeFileNameForFs('a:b?c*d"e<f>g|h\0i\u0007j\u009Fk/l\\m')).toBe('a_b_c_d_e_f_g_h_i_j_k/l\\m');
  });
});

describe('resolve_file_info', () => {
  it('layer 1: URI name with an extension wins without touching the file', () => {
    const uri = 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fbook.pdf';
    expect(resolveFileInfo(uri)).toEqual(['book.pdf', 'pdf']);
    expect(resolveFileInfo(file('weird:name?.BIN', 'x'))).toEqual(['weird_name_.BIN', 'bin']);
  });

  it('layer 2: opaque ids and extension-less names get the magic-detected extension appended', () => {
    expect(resolveFileInfo(file('446', '%PDF-1.7\n'))).toEqual(['446.pdf', 'pdf']);
    expect(resolveFileInfo(file('notes', '# Title\nbody\n'))).toEqual(['notes.md', 'md']);
    expect(resolveFileInfo(file('sheet', Buffer.concat([zipEntry('[Content_Types].xml', '<x/>'), zipEntry('xl/workbook.xml')]))))
      .toEqual(['sheet.xlsx', 'xlsx']);
  });

  it('layer 3: unreadable or unrecognised content keeps the sanitised name and URI extension', () => {
    expect(resolveFileInfo(file('blob', Uint8Array.of(0xff, 0xfe, 0x00, 0x01, 0x80, 0x81)))).toEqual(['blob', null]);
    // 桌面无 SAF：虚拟 URI 读取失败 → magic 检测为 None，不抛错
    expect(resolveFileInfo(VIRTUAL)).toEqual(['446', null]);
    expect(resolveFileInfo(path.join(tmp(), 'missing'))).toEqual(['missing', null]);
  });
});

describe('detect_extension_from_magic', () => {
  it('recognises binary signatures', () => {
    expect(detectExtensionFromMagic(file('a', '%PDF-1.4'))).toBe('pdf');
    expect(detectExtensionFromMagic(file('b', '{\\rtf1\\ansi}'))).toBe('rtf');
    expect(detectExtensionFromMagic(file('c', Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)))).toBeNull();
    expect(detectExtensionFromMagic(file('d', 'abc'))).toBeNull(); // < 4 字节
  });

  it('distinguishes ZIP containers by local file header names and ODF mimetype', () => {
    expect(detectExtensionFromMagic(file('w', zipEntry('word/document.xml')))).toBe('docx');
    expect(detectExtensionFromMagic(file('p', zipEntry('ppt/presentation.xml')))).toBe('pptx');
    expect(detectExtensionFromMagic(file('e', Buffer.concat([zipEntry('mimetype', 'application/epub+zip'), zipEntry('META-INF/container.xml')])))).toBe('epub');
    expect(detectExtensionFromMagic(file('o', zipEntry('mimetype', 'application/vnd.oasis.opendocument.spreadsheet')))).toBe('ods');
    expect(detectExtensionFromMagic(file('q', zipEntry('mimetype', 'application/vnd.oasis.opendocument.presentation')))).toBe('pptx');
    expect(detectExtensionFromMagic(file('t', zipEntry('mimetype', 'application/vnd.oasis.opendocument.text')))).toBe('docx');
    expect(detectExtensionFromMagic(file('x', zipEntry('content.xml')))).toBe('ods');
    expect(detectExtensionFromMagic(file('z', zipEntry('other.bin')))).toBeNull();
  });

  it('classifies XML, XHTML and HTML (with optional BOM)', () => {
    expect(detectExtensionFromMagic(file('x1', '<?xml version="1.0"?><root/>'))).toBe('xml');
    expect(detectExtensionFromMagic(file('x2', '<?xml version="1.0"?><!DOCTYPE html><HTML></HTML>'))).toBe('html');
    expect(detectExtensionFromMagic(file('h1', '\uFEFF<!DOCTYPE html><p>'))).toBe('html');
    expect(detectExtensionFromMagic(file('h2', '<HTML><body>'))).toBe('html');
  });

  it('applies the JSON / CSV / Markdown / text heuristics in Rust order', () => {
    expect(detectExtensionFromMagic(file('j1', '  {"a": [1, 2]}  '))).toBe('json');
    expect(detectExtensionFromMagic(file('j2', '{"a": 1'))).toBe('txt'); // 非法 JSON 且不足 1024 字节
    expect(detectExtensionFromMagic(file('j3', `[${'1,'.repeat(700)}`))).toBe('json'); // 截断样本 ≥ 1024 字节
    expect(detectExtensionFromMagic(file('c1', 'a,b,c\r\n1,2,3\n4,5,6\n'))).toBe('csv');
    expect(detectExtensionFromMagic(file('c2', 'a,b\n1,2,3\n'))).toBe('txt'); // 逗号数不一致
    expect(detectExtensionFromMagic(file('m1', 'intro\n- item\n'))).toBe('md');
    expect(detectExtensionFromMagic(file('m2', 'plain words\n```\ncode\n```'))).toBe('md');
    expect(detectExtensionFromMagic(file('t1', '纯文本内容，没有标记'))).toBe('txt');
    // 1024 字节样本截断在多字节字符中间 → from_utf8 失败 → None
    expect(detectExtensionFromMagic(file('t2', `ab${'中'.repeat(400)}`))).toBeNull();
  });
});

describe('read_all_bytes_bounded', () => {
  it('reads files up to and including the limit', async () => {
    const target = file('ok.bin', 'abcdef');
    expect((await readAllBytesBounded(target, 6)).toString()).toBe('abcdef');
    expect((await readAllBytesBounded(target, 100)).toString()).toBe('abcdef');
    expect((await readAllBytesBounded(file('empty.bin', ''), 0)).length).toBe(0);
  });

  it('rejects oversize local files in the metadata pre-check with the actual size', async () => {
    const target = file('big.bin', 'abcdef');
    await expect(readAllBytesBounded(target, 5)).rejects.toEqual({
      error_type: 'Validation',
      message: `文件过大: 6 字节，超过读取上限 5 字节: ${target}`,
      details: null,
    });
  });

  it('maps missing files, virtual URIs and invalid input to the Rust error kinds', async () => {
    const missing = path.join(tmp(), 'missing.bin');
    await expect(readAllBytesBounded(missing, 10)).rejects.toMatchObject({
      error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^获取文件信息失败: ${missing} \\(`)),
    });
    await expect(readAllBytesBounded(VIRTUAL, 10)).rejects.toEqual({
      error_type: 'FileSystem', message: `读取文件失败: ${VIRTUAL} (虚拟路径在当前平台不可用)`, details: null,
    });
    await expect(readAllBytesBounded('  ', 10)).rejects.toEqual({ error_type: 'Validation', message: '路径不能为空', details: null });
    await expect(readAllBytesBounded('content%3A%2F%2Fx%2Fdoc', 10)).rejects.toMatchObject({ error_type: 'Validation' });
  });

  it('accepts file:// URIs with percent-encoded local paths', async () => {
    const target = file('名 字.txt', 'hi');
    expect((await readAllBytesBounded(`file://${encodeURI(target)}`, 2)).toString()).toBe('hi');
  });

  it('reports read failures (directory) as 读取文件失败', async () => {
    const dir = tmp();
    if (process.platform === 'win32') return; // Windows 无法以读方式打开目录，open 失败同样走 读取文件失败
    await expect(readAllBytesBounded(dir, 1 << 30)).rejects.toMatchObject({
      error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^读取文件失败: ${dir} \\(`)),
    });
  });
});

describe('get_file_size', () => {
  it('returns the metadata length of local files', () => {
    expect(getFileSize(file('s.bin', Buffer.alloc(12345)))).toBe(12345);
  });
  it('maps missing files and virtual URIs to FileSystem errors', () => {
    const missing = path.join(tmp(), 'missing.bin');
    expect(thrown(() => getFileSize(missing))).toMatchObject({
      error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^获取文件信息失败: ${missing} \\(`)),
    });
    expect(thrown(() => getFileSize(VIRTUAL))).toEqual({
      error_type: 'FileSystem', message: `读取文件失败: ${VIRTUAL} (虚拟路径在当前平台不可用)`, details: null,
    });
  });
});

describe('hash_file_sha256', () => {
  it('streams lowercase hex SHA-256 across chunk boundaries', async () => {
    expect(await hashFileSha256(file('abc.txt', 'abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await hashFileSha256(file('empty.txt', ''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const big = Buffer.alloc(64 * 1024 * 3 + 7, 0x61);
    const expected = (await import('node:crypto')).createHash('sha256').update(big).digest('hex');
    expect(await hashFileSha256(file('big.bin', big))).toBe(expected);
  });
  it('maps open failures to 读取文件失败', async () => {
    const missing = path.join(tmp(), 'missing.bin');
    await expect(hashFileSha256(missing)).rejects.toMatchObject({
      error_type: 'FileSystem', message: expect.stringMatching(new RegExp(`^读取文件失败: ${missing} \\(`)),
    });
    await expect(hashFileSha256(VIRTUAL)).rejects.toEqual({
      error_type: 'FileSystem', message: `读取文件失败: ${VIRTUAL} (虚拟路径在当前平台不可用)`, details: null,
    });
  });
});
