import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock('@/features/chat/context/vfsRefApiEnhancements', () => ({
  invalidateResourceCache: vi.fn(),
}));

import { dstu } from '../api';

const SAMPLE_RESOURCE = {
  id: 'res-html-1',
  name: 'index.html',
  path: '/sine-superposition/index.html',
  resourceType: 'code',
  content: '<html><body><canvas id="c"></canvas></body></html>',
  createdAt: '2026-11-24T00:00:00Z',
  updatedAt: '2026-11-24T00:00:00Z',
};

describe('dstu.get relative path normalization (S3-08)', () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it('routes relative workspace artifact paths like sine-superposition/index.html to dstu_get_resource_by_path', async () => {
    mocks.invoke.mockResolvedValue(SAMPLE_RESOURCE);

    const res = await dstu.get('sine-superposition/index.html');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('res-html-1');
    }
    expect(mocks.invoke).toHaveBeenCalledWith('dstu_get_resource_by_path', {
      path: '/sine-superposition/index.html',
    });
  });

  it('strips leading ./ from relative artifact paths before calling dstu_get_resource_by_path', async () => {
    mocks.invoke.mockResolvedValue(SAMPLE_RESOURCE);

    await dstu.get('./sine-superposition/index.html');
    expect(mocks.invoke).toHaveBeenCalledWith('dstu_get_resource_by_path', {
      path: '/sine-superposition/index.html',
    });
  });

  it('falls back to dstu_get_resource_by_path if dstu_get rejects with Invalid DSTU path', async () => {
    mocks.invoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'dstu_get') {
        throw new Error('Invalid DSTU path');
      }
      if (cmd === 'dstu_get_resource_by_path') {
        return SAMPLE_RESOURCE;
      }
      throw new Error(`Unexpected command ${cmd}`);
    });

    const res = await dstu.get('artifact-without-ext');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('res-html-1');
    }
    expect(mocks.invoke).toHaveBeenCalledWith('dstu_get', { path: '/artifact-without-ext' });
    expect(mocks.invoke).toHaveBeenCalledWith('dstu_get_resource_by_path', {
      path: '/artifact-without-ext',
    });
  });
});
