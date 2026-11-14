import { describe, expect, it } from 'vitest';
import { officeText, parseCsvRecords } from '../office/text.ts';

describe('document_parser text decoder', () => {
  it('test_txt_support', () => {
    expect(officeText.extractPlainText(Buffer.from('Hello, World!'))).toBe('Hello, World!');
  });
  it('test_txt_with_unicode', () => {
    expect(officeText.extractPlainText(Buffer.from('中文测试 English Test 123'))).toBe('中文测试 English Test 123');
  });
  it('test_md_support', () => {
    expect(officeText.extractPlainText(Buffer.from('# 标题\n\n这是**Markdown**内容。'))).toBe('# 标题\n\n这是**Markdown**内容。');
  });
  it('test_txt_gbk_decoding', () => {
    const result = officeText.extractPlainText(Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]));
    expect(result).toBe('中文测试');
    expect(result).not.toContain('\ufffd');
  });
  it('test_txt_utf8_bom_decoding', () => {
    expect(officeText.extractPlainText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 文本')]))).toBe('BOM 文本');
  });
});

describe('csv-core default dialect vectors', () => {
  it.each<[string, string, string[][]]>([
    ['one_row_trailing_comma', 'a,b,', [['a', 'b', '']]],
    ['one_row_many_fields_crlf', 'a,b,c\r\n', [['a', 'b', 'c']]],
    ['many_rows_many_fields', 'a,b,c\nx,y,z', [['a', 'b', 'c'], ['x', 'y', 'z']]],
    ['trailing_lines_no_record', '\n\n\na,b,c\nx,y,z\n\n\n', [['a', 'b', 'c'], ['x', 'y', 'z']]],
    ['empty', '', []],
    ['empty_lines_mixed', '\r\n\n\r\n\n', []],
    ['bom_at_start', '\ufeffa', [['a']]],
    ['bom_in_field', 'a\ufeff', [['a\ufeff']]],
    ['bom_at_field_start', 'a,\ufeffb', [['a', '\ufeffb']]],
    ['quote_empty', '""', [['']]],
    ['quote_inner_space', '" a "', [[' a ']]],
    ['quote_outer_space', '  "a"  ', [['  "a"  ']]],
    ['quote_no_escapes', '"a\\"b"', [['a\\b"']]],
  ])('%s', (_name, input, expected) => {
    expect(parseCsvRecords(input)).toEqual(expected);
  });
  it('retains flexible rows, multiline fields, doubled quotes and Rust whitespace trimming', () => {
    expect(officeText.extractCsv(Buffer.from('name,value\r\n"a,b","a""b"\r\nlast'))).toBe('name\tvalue\na,b\ta"b\nlast');
    expect(officeText.extractCsv(Buffer.from('a,b\n"x\ny",2'))).toBe('a\tb\nx\ny\t2');
    expect(officeText.extractPlainText(Buffer.from('\u0085value\u0085'))).toBe('value');
    expect(officeText.extractPlainText(Buffer.from('value\ufeff'))).toBe('value\ufeff');
  });
});
