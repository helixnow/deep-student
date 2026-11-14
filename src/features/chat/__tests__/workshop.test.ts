import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ create: vi.fn(), activate: vi.fn(), get: vi.fn(), navigate: vi.fn() }));
vi.mock('../core/session/createSessionWithDefaults', () => ({ createSessionWithDefaults: mocks.create }));
vi.mock('../core/session/sessionManager', () => ({ sessionManager: { getOrCreate: mocks.get } }));
vi.mock('../navigation/pendingChatNavigation', () => ({ requestChatSessionNavigation: mocks.navigate }));
import { workshopSessions } from '../workshop';

describe('chat workshop assembly port', () => {
  it('creates without global default skills and touches only the new session', async () => {
    mocks.create.mockResolvedValue({ id: 'new' });
    mocks.activate.mockResolvedValue(true);
    mocks.get.mockReturnValue({ getState: () => ({ activateSkill: mocks.activate }) });
    const options = { mode: 'chat' as const, title: '插件工坊', metadata: { dstuWorkshop: { kind: 'create' } } };
    const session = await workshopSessions.create(options);
    expect(mocks.create).toHaveBeenCalledWith({ ...options, defaultSkillIds: [] });
    expect(await workshopSessions.activateSkill(session.id, 'dstu-plugin-development')).toBe(true);
    expect(mocks.get).toHaveBeenCalledExactlyOnceWith('new');
    expect(mocks.activate).toHaveBeenCalledExactlyOnceWith('dstu-plugin-development');
    workshopSessions.navigate(session.id);
    expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith('new');
  });
});
