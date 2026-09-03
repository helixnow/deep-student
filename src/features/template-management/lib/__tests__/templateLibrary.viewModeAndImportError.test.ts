import { beforeEach, describe, expect, it } from 'vitest';

import {
  classifyTemplateImportError,
  persistViewMode,
  readStoredViewMode,
} from '../templateLibrary';

const VIEW_MODE_STORAGE_KEY = 'template-management:view-mode';

describe('模板库视图模式持久化', () => {
  beforeEach(() => {
    window.localStorage.removeItem(VIEW_MODE_STORAGE_KEY);
  });

  it('无历史记录时默认为 grid', () => {
    expect(readStoredViewMode()).toBe('grid');
  });

  it('persistViewMode 写入后 readStoredViewMode 读回同值', () => {
    persistViewMode('list');
    expect(readStoredViewMode()).toBe('list');

    persistViewMode('grid');
    expect(readStoredViewMode()).toBe('grid');
  });

  it('存储值被污染时回退为 grid（不抛错）', () => {
    window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, 'mosaic');
    expect(readStoredViewMode()).toBe('grid');
  });
});

describe('classifyTemplateImportError 导入失败归类', () => {
  it('权限类信号 → permission', () => {
    expect(classifyTemplateImportError('Permission denied (os error 13)')).toBe('permission');
    expect(classifyTemplateImportError('path /tmp/x.json not allowed by scope')).toBe('permission');
  });

  it('serde 结构校验类信号 → not_template', () => {
    expect(classifyTemplateImportError('missing field `front_template` at line 1 column 20')).toBe('not_template');
    expect(classifyTemplateImportError('invalid type: string, expected a sequence')).toBe('not_template');
  });

  it('JSON 语法类信号 → invalid_json', () => {
    expect(classifyTemplateImportError("Unexpected token '<', \"<html>\" is not valid JSON")).toBe('invalid_json');
    expect(classifyTemplateImportError('EOF while parsing a value at line 3 column 0')).toBe('invalid_json');
    expect(classifyTemplateImportError('trailing characters at line 2 column 1')).toBe('invalid_json');
  });

  it('权限信号优先于同时包含的其他信号', () => {
    expect(classifyTemplateImportError('access denied: invalid type in payload')).toBe('permission');
  });

  it('无信号命中 → unknown', () => {
    expect(classifyTemplateImportError('something exploded')).toBe('unknown');
    expect(classifyTemplateImportError('')).toBe('unknown');
  });
});
