import { describe, expect, it } from 'vitest';
import { assessAuthorizedRootRisk } from '../runtimeRootRisk';

describe('assessAuthorizedRootRisk', () => {
  it('深层子目录为 safe（含个人目录的深层子目录）', () => {
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\Documents\\学习资料\\高数')).toBe('safe');
    expect(assessAuthorizedRootRisk('C:/Users/helix/Documents/学习资料/高数')).toBe('safe');
    expect(assessAuthorizedRootRisk('E:\\2026ds\\deep-student')).toBe('safe');
    expect(assessAuthorizedRootRisk('/home/helix/projects/notes')).toBe('safe');
  });

  it('Desktop/Downloads/Documents 目录本身为 broad', () => {
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\Documents')).toBe('broad');
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\Desktop')).toBe('broad');
    expect(assessAuthorizedRootRisk('C:/Users/helix/Downloads')).toBe('broad');
    expect(assessAuthorizedRootRisk('D:\\Documents')).toBe('broad');
    expect(assessAuthorizedRootRisk('~/Documents')).toBe('broad');
  });

  it('中文个人目录名（桌面/下载/文档）同样为 broad', () => {
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\桌面')).toBe('broad');
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\下载')).toBe('broad');
    expect(assessAuthorizedRootRisk('D:\\文档')).toBe('broad');
    expect(assessAuthorizedRootRisk('C:\\Users\\helix\\文档\\学习资料')).toBe('safe');
  });

  it('盘符根与文件系统根为 critical', () => {
    expect(assessAuthorizedRootRisk('C:\\')).toBe('critical');
    expect(assessAuthorizedRootRisk('D:\\')).toBe('critical');
    expect(assessAuthorizedRootRisk('d:/')).toBe('critical');
    expect(assessAuthorizedRootRisk('/')).toBe('critical');
  });

  it('用户主目录本身及其父级为 critical', () => {
    expect(assessAuthorizedRootRisk('C:\\Users\\helix')).toBe('critical');
    expect(assessAuthorizedRootRisk('c:\\users\\helix\\')).toBe('critical');
    expect(assessAuthorizedRootRisk('C:\\Users')).toBe('critical');
    expect(assessAuthorizedRootRisk('/home/helix')).toBe('critical');
    expect(assessAuthorizedRootRisk('/Users/helix')).toBe('critical');
    expect(assessAuthorizedRootRisk('~')).toBe('critical');
  });

  it('大小写不敏感且兼容反斜杠/正斜杠混用', () => {
    expect(assessAuthorizedRootRisk('c:\\USERS\\helix\\DESKTOP')).toBe('broad');
    expect(assessAuthorizedRootRisk('C:/Users\\helix/Documents')).toBe('broad');
  });

  it('空输入与相对路径为 safe', () => {
    expect(assessAuthorizedRootRisk('')).toBe('safe');
    expect(assessAuthorizedRootRisk('   ')).toBe('safe');
    expect(assessAuthorizedRootRisk('docs/reports')).toBe('safe');
  });
});
