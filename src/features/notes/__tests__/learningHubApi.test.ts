/**
 * learningHubApi 单测
 *
 * 覆盖：
 * - B7：buildPathForSource 的 DSTU 简化路径行为（经 fetchReferenceContent 间接验证）
 * - fetchReferenceContent / fetchReferenceNode / validateReference 的输入校验短路
 * - canReferenceToChat 支持面（与 tests/vitest/notes/learningHubApi-contracts.test.ts 一致）
 * - mapSourceToResourceType 遗留值兼容
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/dstu', () => ({
  dstu: {
    get: vi.fn(),
    getContent: vi.fn(),
  },
}));

import { dstu } from '@/dstu';
import {
  fetchReferenceContent,
  fetchReferenceNode,
  validateReference,
  canReferenceToChat,
  mapSourceToResourceType,
  type SourceDatabase,
} from '../learningHubApi';

const mockedGet = vi.mocked(dstu.get);
const mockedGetContent = vi.mocked(dstu.getContent);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('fetchReferenceContent DSTU 路径（B7）', () => {
  it.each<[SourceDatabase, string]>([
    ['notes', 'note_abc123'],
    ['textbooks', 'tb_xyz789'],
    ['exam_sessions', 'exam_001'],
    ['chat_v2', 'res_777'],
  ])('sourceDb=%s 时按 ID 全局寻址为 /${sourceId}', async (sourceDb, sourceId) => {
    mockedGetContent.mockResolvedValue({ ok: true, value: '# hi' } as never);
    mockedGet.mockResolvedValue({
      ok: true,
      value: { id: sourceId, name: 'Title', metadata: {} },
    } as never);

    const result = await fetchReferenceContent({ sourceDb, sourceId });

    // 后端 dstu_get / dstu_get_content 按 ID 前缀推断资源类型，
    // 简化路径 /${sourceId} 即全局寻址规范形式，与 sourceDb 无关。
    expect(mockedGetContent).toHaveBeenCalledWith(`/${sourceId}`);
    expect(mockedGet).toHaveBeenCalledWith(`/${sourceId}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.content).toBe('# hi');
      expect(result.value.metadata.title).toBe('Title');
    }
  });

  it('sourceId 前后空白会被 trim 后再寻址', async () => {
    mockedGetContent.mockResolvedValue({ ok: true, value: 'x' } as never);
    mockedGet.mockResolvedValue({
      ok: true,
      value: { id: 'note_1', name: 'N', metadata: {} },
    } as never);

    await fetchReferenceContent({ sourceDb: 'notes', sourceId: '  note_1  ' });
    expect(mockedGetContent).toHaveBeenCalledWith('/note_1');
  });

  it('空 sourceId 直接返回 VALIDATION 错误且不发起后端调用', async () => {
    const result = await fetchReferenceContent({ sourceDb: 'notes', sourceId: '   ' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('VALIDATION');
    }
    expect(mockedGetContent).not.toHaveBeenCalled();
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('内容获取失败时透传 DSTU 错误（Result 形状不变）', async () => {
    const dstuError = { code: 'NOT_FOUND', message: 'missing' };
    mockedGetContent.mockResolvedValue({ ok: false, error: dstuError } as never);
    mockedGet.mockResolvedValue({
      ok: true,
      value: { id: 'note_1', name: 'N' },
    } as never);

    const result = await fetchReferenceContent({ sourceDb: 'notes', sourceId: 'note_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(dstuError);
    }
  });
});

describe('fetchReferenceNode / validateReference 输入校验', () => {
  it('fetchReferenceNode 空 sourceId 短路为 VALIDATION 错误', async () => {
    const result = await fetchReferenceNode({ sourceDb: 'textbooks', sourceId: '' });
    expect(result.ok).toBe(false);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('validateReference 空 sourceId 返回 false 且不发起后端调用', async () => {
    await expect(validateReference('textbooks', '')).resolves.toBe(false);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('validateReference 后端 ok 时返回 true', async () => {
    mockedGet.mockResolvedValue({ ok: true, value: { id: 'tb_1' } } as never);
    await expect(validateReference('textbooks', 'tb_1')).resolves.toBe(true);
    expect(mockedGet).toHaveBeenCalledWith('/tb_1');
  });
});

describe('canReferenceToChat 支持面（合同锁定）', () => {
  it('notes/textbooks/chat_v2/exam_sessions 可引用', () => {
    (['notes', 'textbooks', 'chat_v2', 'exam_sessions'] as const).forEach((sourceDb) => {
      expect(canReferenceToChat({ sourceDb })).toBe(true);
    });
  });

  it('缺省 / attachments / mindmaps 不可引用', () => {
    expect(canReferenceToChat({})).toBe(false);
    expect(canReferenceToChat({ sourceDb: 'attachments' })).toBe(false);
    expect(canReferenceToChat({ sourceDb: 'mindmaps' })).toBe(false);
  });
});

describe('mapSourceToResourceType（合同锁定 + 遗留值）', () => {
  it('保持稳定映射', () => {
    expect(mapSourceToResourceType('notes')).toEqual({ resourceType: 'note', typeId: 'note' });
    expect(mapSourceToResourceType('textbooks')).toEqual({ resourceType: 'file', typeId: 'textbook' });
    expect(mapSourceToResourceType('exam_sessions')).toEqual({ resourceType: 'exam', typeId: 'exam' });
    expect(mapSourceToResourceType('chat_v2')).toEqual({ resourceType: 'file', typeId: 'file' });
    // 遗留值走 default 分支
    expect(mapSourceToResourceType('mistakes')).toEqual({ resourceType: 'file', typeId: 'file' });
  });
});
