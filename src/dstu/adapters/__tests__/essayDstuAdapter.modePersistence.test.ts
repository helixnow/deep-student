import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = new Map<string, string>();
const { dstuMock, apiMock } = vi.hoisted(() => ({
  dstuMock: { setMetadata: vi.fn(), get: vi.fn() },
  apiMock: { getSession: vi.fn(), getRounds: vi.fn(), createSession: vi.fn() },
}));

vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('../../api', () => ({ dstu: dstuMock }));
vi.mock('@/utils/settingsApi', () => ({
  getSetting: vi.fn(async (key: string) => settings.get(key) ?? null),
  saveSetting: vi.fn(async (key: string, value: string) => { settings.set(key, value); }),
}));
vi.mock('@/essay-grading/essayGradingApi', () => ({
  EssayGradingAPI: apiMock,
  canonicalizeEssayModeId: (id: string) => id,
}));

import { essayDstuAdapter } from '../essayDstuAdapter';

describe('作文会话批阅模式持久化', () => {
  beforeEach(() => {
    settings.clear();
    vi.clearAllMocks();
    apiMock.getSession.mockResolvedValue({
      id: 'essay_session_1', title: 't', essay_type: '', grade_level: '',
      is_favorite: false, created_at: '2026-10-02T00:00:00Z', updated_at: '2026-10-02T00:00:00Z',
    });
    apiMock.getRounds.mockResolvedValue([]);
  });

  it('仅改模式时写入会话设置且不打 DSTU（后端要求至少一个元数据字段）', async () => {
    const result = await essayDstuAdapter.updateSessionMeta('essay_session_1', { modeId: 'ielts' });
    expect(result.ok).toBe(true);
    expect(dstuMock.setMetadata).not.toHaveBeenCalled();
    const session = await essayDstuAdapter.getFullSession('essay_session_1');
    expect(session.ok && session.value.modeId).toBe('ielts');
  });

  it('未保存过模式时留空，交给工作台按上次使用的模式恢复', async () => {
    const session = await essayDstuAdapter.getFullSession('essay_session_1');
    expect(session.ok && session.value?.modeId).toBe('');
  });
});
