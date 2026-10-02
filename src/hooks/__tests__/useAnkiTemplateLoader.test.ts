import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const templates: Record<string, { id: string; name: string }> = {
  'design-lab': { id: 'design-lab', name: 'Lab' },
  'design-marginalia': { id: 'design-marginalia', name: 'Marginalia' },
};
let resolveSecond: (() => void) | null = null;

vi.mock('@/data/ankiTemplates', () => ({ templateManager: { subscribe: () => () => {} } }));
vi.mock('@/services/templateService', () => ({
  TemplateService: {
    getInstance: () => ({
      getTemplateById: (id: string) =>
        id === 'design-marginalia'
          ? new Promise((resolve) => { resolveSecond = () => resolve(templates[id]); })
          : Promise.resolve(templates[id]),
    }),
  },
}));

import { useAnkiTemplateLoader } from '../useAnkiTemplateLoader';

describe('useAnkiTemplateLoader', () => {
  it('never returns the previous card template while the next one loads', async () => {
    const { result, rerender } = renderHook(({ id }) => useAnkiTemplateLoader(id), {
      initialProps: { id: 'design-lab' as string | null },
    });
    await waitFor(() => expect(result.current.template?.id).toBe('design-lab'));

    rerender({ id: 'design-marginalia' });
    // 切卡首帧起就不能再拿到 design-lab
    expect(result.current.template).toBeNull();
    expect(result.current.loading).toBe(true);

    await act(async () => { resolveSecond?.(); });
    await waitFor(() => expect(result.current.template?.id).toBe('design-marginalia'));
    expect(result.current.loading).toBe(false);
  });
});
