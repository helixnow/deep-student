/**
 * DSTU API 单元测试
 *
 * 覆盖范围：
 * - Result 版 `dstu` API：返回结构与错误分支
 * - 纯前端 `pathUtils`：真实路径 parse/build
 * - `createDstuError`：错误契约
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
          return [makeNode('note_123', 'note', '测试笔记')];
        case 'dstu_get':
          if (payload?.path?.includes('missing')) return null;
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
        case 'dstu_search':
          return [makeNode('note_123', 'note', '测试笔记')];
        default:
          throw new Error(`Unhandled invoke: ${cmd}`);
      }
    }),
  };
});

import { invoke } from '@tauri-apps/api/core';
import {
  dstu,
  pathUtils,
  type DstuNode,
  type DstuNodeType,
  type DstuListOptions,
  type DstuCreateOptions,
  createDstuError,
} from '@/dstu';

// ============================================================================
// pathUtils 测试（真实路径系统）
// ============================================================================

describe('pathUtils', () => {
  it('parse: 根目录', () => {
    expect(pathUtils.parse('/')).toEqual({
      fullPath: '/',
      folderPath: null,
      resourceId: null,
      id: null,
      resourceType: null,
      isRoot: true,
      isVirtual: false,
    });
  });

  it('parse: 文件夹路径', () => {
    const parsed = pathUtils.parse('/高考复习/函数');
    expect(parsed.folderPath).toBe('/高考复习/函数');
    expect(parsed.resourceId).toBeNull();
    expect(parsed.resourceType).toBeNull();
    expect(parsed.isVirtual).toBe(false);
  });

  it('parse: 资源路径（从 ID 推断类型）', () => {
    const parsed = pathUtils.parse('/高考复习/函数/note_123');
    expect(parsed.folderPath).toBe('/高考复习/函数');
    expect(parsed.resourceId).toBe('note_123');
    expect(parsed.resourceType).toBe('note');
    expect(parsed.isVirtual).toBe(false);
  });

  it('build: 根目录资源', () => {
    expect(pathUtils.build(null, 'note_123')).toBe('/note_123');
    expect(pathUtils.build('/', 'note_123')).toBe('/note_123');
  });

  it('build: 文件夹下资源', () => {
    expect(pathUtils.build('/高考复习/函数', 'note_123')).toBe('/高考复习/函数/note_123');
    expect(pathUtils.build('高考复习/函数', 'note_123')).toBe('/高考复习/函数/note_123');
  });
});

// ============================================================================
// DstuError 测试
// ============================================================================

describe('createDstuError', () => {
  it('创建带有正确属性的错误', () => {
    const error = createDstuError('NOT_FOUND', '资源未找到', '/note_123');

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('资源未找到');
    expect(error.path).toBe('/note_123');
    expect(error.name).toBe('DstuError');
  });

  it('支持所有错误代码', () => {
    const codes = ['NOT_FOUND', 'INVALID_PATH', 'PERMISSION_DENIED', 'CONFLICT', 'INTERNAL'] as const;

    for (const code of codes) {
      const error = createDstuError(code, `错误: ${code}`);
      expect(error.code).toBe(code);
    }
  });
});

// ============================================================================
// dstu API Result 契约测试
// ============================================================================

describe('dstu API (Result)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('list: ok + 调用 dstu_list', async () => {
    const result = await dstu.list('/', { typeFilter: 'note' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.value)).toBe(true);
    }
    expect(vi.mocked(invoke)).toHaveBeenCalledWith('dstu_list', {
      path: '/',
      options: { typeFilter: 'note' },
    });
  });

  it('get: not found → Result.err', async () => {
    const result = await dstu.get('/missing_note_123');
    expect(result.ok).toBe(false);
  });

  it('create/update/getContent/setMetadata/delete/search: 返回 Result', async () => {
    const created = await dstu.create('/', { type: 'note', name: '新建笔记', content: '# 测试' });
    expect(created.ok).toBe(true);

    const updated = await dstu.update('/note_123', '# 更新', 'note');
    expect(updated.ok).toBe(true);

    const content = await dstu.getContent('/note_123');
    expect(content.ok).toBe(true);
    if (content.ok) expect(typeof content.value).toBe('string');

    const setMeta = await dstu.setMetadata('/note_123', { title: '新标题' });
    expect(setMeta.ok).toBe(true);

    const del = await dstu.delete('/note_123');
    expect(del.ok).toBe(true);

    const searched = await dstu.search('测试', { types: ['note'] });
    expect(searched.ok).toBe(true);
  });
});

// ============================================================================
// 类型契约测试（仅做 TS 层面约束）
// ============================================================================

describe('类型契约', () => {
  it('DstuNodeType 包含所有必需类型', () => {
    const types: DstuNodeType[] = [
      'folder',
      'note',
      'textbook',
      'exam',
      'translation',
      'essay',
      'image',
      'file',
      'retrieval',
    ];

    expect(types).toHaveLength(9);
  });

  it('DstuNode 类型包含所有必需字段', () => {
    const node: DstuNode = {
      id: 'note_test',
      sourceId: 'note_test',
      path: '/note_test',
      name: 'Test',
      type: 'note',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(node.id).toBeDefined();
    expect(node.sourceId).toBeDefined();
    expect(node.path).toBeDefined();
    expect(node.name).toBeDefined();
    expect(node.type).toBeDefined();
    expect(node.createdAt).toBeDefined();
    expect(node.updatedAt).toBeDefined();
  });

  it('DstuListOptions 类型包含所有可选字段', () => {
    const options: DstuListOptions = {
      recursive: true,
      types: ['note', 'textbook'],
      search: '搜索词',
      sortBy: 'createdAt',
      sortOrder: 'desc',
      limit: 10,
      offset: 0,
    };

    expect(options).toBeDefined();
  });

  it('DstuCreateOptions 类型包含所有字段', () => {
    const options: DstuCreateOptions = {
      type: 'note',
      name: '新笔记',
      content: '内容',
      metadata: { tags: ['tag1'] },
    };

    expect(options.type).toBe('note');
    expect(options.name).toBe('新笔记');
    expect(options.content).toBe('内容');
    expect(options.metadata).toBeDefined();
  });
});
