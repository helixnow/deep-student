import { describe, expect, it } from 'vitest';

import { isSinglePasteUrl, normalizePasteHref } from '../isSinglePasteUrl';

describe('isSinglePasteUrl', () => {
  it('accepts https and http URLs', () => {
    expect(isSinglePasteUrl('https://example.com')).toBe('https://example.com');
    expect(isSinglePasteUrl('http://example.com/path')).toBe('http://example.com/path');
  });

  it('trims surrounding whitespace', () => {
    expect(isSinglePasteUrl('  https://example.com/a  ')).toBe('https://example.com/a');
  });

  it('accepts www. prefix', () => {
    expect(isSinglePasteUrl('www.example.com')).toBe('www.example.com');
    expect(isSinglePasteUrl('WWW.Example.COM/x')).toBe('WWW.Example.COM/x');
  });

  it('accepts query and hash', () => {
    expect(isSinglePasteUrl('https://example.com/a?q=1&b=2#hash')).toBe(
      'https://example.com/a?q=1&b=2#hash',
    );
  });

  it('accepts Chinese path / query without spaces', () => {
    expect(isSinglePasteUrl('https://example.com/中文路径')).toBe(
      'https://example.com/中文路径',
    );
    expect(isSinglePasteUrl('https://例.com/搜索?q=深度')).toBe(
      'https://例.com/搜索?q=深度',
    );
  });

  it('rejects multiline text', () => {
    expect(isSinglePasteUrl('https://example.com\nhttps://other.com')).toBeNull();
    expect(isSinglePasteUrl('https://a.com\rhttps://b.com')).toBeNull();
  });

  it('accepts URL with only surrounding newlines after trim', () => {
    expect(isSinglePasteUrl('https://example.com\r\n')).toBe('https://example.com');
    expect(isSinglePasteUrl('\nhttps://example.com\n')).toBe('https://example.com');
  });

  it('rejects text with spaces', () => {
    expect(isSinglePasteUrl('https://example.com/foo bar')).toBeNull();
    expect(isSinglePasteUrl('see https://example.com')).toBeNull();
  });

  it('rejects non-URL plain text', () => {
    expect(isSinglePasteUrl('hello')).toBeNull();
    expect(isSinglePasteUrl('ftp://example.com')).toBeNull();
    expect(isSinglePasteUrl('example.com')).toBeNull();
    expect(isSinglePasteUrl('')).toBeNull();
    expect(isSinglePasteUrl('   ')).toBeNull();
  });
});

describe('normalizePasteHref', () => {
  it('prefixes https for www.', () => {
    expect(normalizePasteHref('www.example.com')).toBe('https://www.example.com');
  });

  it('leaves http(s) unchanged', () => {
    expect(normalizePasteHref('https://example.com')).toBe('https://example.com');
    expect(normalizePasteHref('http://example.com')).toBe('http://example.com');
  });
});
