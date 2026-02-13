/**
 * Learning Hub DSTU API 集成测试（单元级 mock）
 *
 * 目标：
 * - 验证 Learning Hub/Notes 侧常用 DSTU 调用模式与 Result 契约一致
 * - 避免依赖真实 Tauri 后端（通过 mock invoke）
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/api/core', () => {
  const now = 1700000000000;
  const makeNode = (id: string, type: string, name?: string) => ({
    id,
    sourceId: id,
    path: `/${id}`,
    name: name ?? '测试',
    type,
    createdAt: now,
    updatedAt: now,
    resourceHash: 'hash_test',
  });

  return {
    convertFileSrc: (p: string) => p,
    invoke: vi.fn(async (cmd: string, payload: any) => {
      switch (cmd) {
        case 'dstu_list':
          return [makeNode('note_123', payload?.options?.typeFilter ?? 'note', '测试笔记')];
        case 'dstu_search':
          return [makeNode('note_123', 'note', '测试笔记')];
        case 'dstu_get':
          return makeNode('note_123', 'note', '测试笔记');
        case 'dstu_create':
          return makeNode('note_new', payload?.options?.type ?? 'note', payload?.options?.name);
        case 'dstu_update':
          return makeNode('note_123', payload?.resourceType ?? 'note', '测试笔记');
        case 'dstu_get_content':
          return '# 测试内容';
        case 'dstu_set_metadata':
        case 'dstu_set_favorite':
        case 'dstu_delete':
          return;
        default:
          throw new Error(`Unhandled invoke: ${cmd}`);
      }
    }),
  };
});

import { invoke } from '@tauri-apps/api/core';
import { dstu } from '@/dstu';

// Mock NotesAPI 以隔离测试（此文件不验证 NotesAPI 本身）
vi.mock('@/utils/notesApi', () => ({
  NotesAPI: {
    listNotes: vi.fn().mockResolvedValue([]),
    createNote: vi.fn().mockResolvedValue({ id: 'note_test', title: '测试' }),
    updateNote: vi.fn().mockResolvedValue({ id: 'note_test', title: '更新' }),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    getNoteContent: vi.fn().mockResolvedValue('# 测试内容'),
    searchNotes: vi.fn().mockResolvedValue([]),
    setFavorite: vi.fn().mockResolvedValue({ id: 'note_test', is_favorite: true }),
  },
}));

describe('Learning Hub - DSTU 调用模式', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dstu.list: 通过 typeFilter 列出笔记', async () => {
    const result = await dstu.list('/', { typeFilter: 'note' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Array.isArray(result.value)).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_list', {
      path: '/',
      options: { typeFilter: 'note' },
    });
  });

  it('dstu.update: 更新笔记内容', async () => {
    const result = await dstu.update('/note_123', '# 更新后的内容', 'note');
    expect(result.ok).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_update', {
      path: '/note_123',
      content: '# 更新后的内容',
      resourceType: 'note',
    });
  });

  it('dstu.getContent: 获取笔记内容', async () => {
    const result = await dstu.getContent('/note_123');
    expect(result.ok).toBe(true);
    if (result.ok) expect(typeof result.value).toBe('string');
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_get_content', { path: '/note_123' });
  });

  it('dstu.setMetadata: 设置元数据（重命名/标签等）', async () => {
    const result = await dstu.setMetadata('/note_123', { title: '新标题' });
    expect(result.ok).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_set_metadata', {
      path: '/note_123',
      metadata: { title: '新标题' },
    });
  });

  it('dstu.create: 创建笔记', async () => {
    const result = await dstu.create('/', { type: 'note', name: '新建笔记', content: '# 新笔记内容' });
    expect(result.ok).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_create', {
      path: '/',
      options: {
        type: 'note',
        name: '新建笔记',
        content: '# 新笔记内容',
        fileBase64: undefined,
        metadata: undefined,
      },
    });
  });

  it('dstu.delete: 删除笔记', async () => {
    const result = await dstu.delete('/note_123');
    expect(result.ok).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_delete', { path: '/note_123' });
  });

  it('dstu.search: 搜索笔记', async () => {
    const result = await dstu.search('测试', { types: ['note'] });
    expect(result.ok).toBe(true);
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_search', { query: '测试', options: { types: ['note'] } });
  });
});
