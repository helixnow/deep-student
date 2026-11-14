import { describe, expect, it, vi } from 'vitest';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import { createDefaultModelAssignments } from '../src/config_recovery.ts';

describe('production Anki routing service (L02-08)', () => {
  it('reads live assignments and configs and routes the critic/generator without writing or network', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const assignments = { ...createDefaultModelAssignments(), anki_card_model_config_id: 'cheap', model2_config_id: 'strong' };
      vi.spyOn(host.ctx.llm, 'getModelAssignments').mockResolvedValue(assignments);
      vi.spyOn(host.ctx.llm, 'getApiConfigs').mockResolvedValue([
        makeConfig({ id: 'cheap', model: 'small', enabled: true }),
        makeConfig({ id: 'strong', model: 'large', enabled: true, isMultimodal: true }),
      ]);
      const routing = host.ctx.llmAnkiRouting;
      expect(await routing.resolveAnkiRoleDecision('critic', 'auto')).toMatchObject({ role: 'critic', configId: 'strong', degraded: false });
      expect(await routing.resolveAnkiRoleDecision('generator', 'auto')).toMatchObject({ role: 'generator', configId: 'cheap' });
      expect(await routing.resolveAnkiRoleDecision('vlm', 'single')).toMatchObject({ configId: 'cheap', isMultimodal: false });
      const slots = await routing.probeAnkiRoutingSlots();
      expect(slots.vision?.configId).toBe('strong');
    } finally { await host.dispose(); vi.restoreAllMocks(); }
  });
  it('retains Rust best-effort read order and returns no plan on either read failure', async () => {
    const host = await createTestHost({ plugins: [plugin], provide: { settings: {}, secrets: {} } });
    try {
      const assignments = vi.spyOn(host.ctx.llm, 'getModelAssignments').mockRejectedValue(new Error('assignments unavailable'));
      const configs = vi.spyOn(host.ctx.llm, 'getApiConfigs').mockRejectedValue(new Error('configs unavailable'));
      expect(await host.ctx.llmAnkiRouting.resolveAnkiRoleDecision('planner', 'auto')).toBeNull();
      expect(configs).not.toHaveBeenCalled();
      assignments.mockResolvedValue(createDefaultModelAssignments());
      expect(await host.ctx.llmAnkiRouting.probeAnkiRoutingSlots()).toEqual({ ankiCard: null, main: null, vision: null });
      expect(configs).toHaveBeenCalledTimes(1);
    } finally { await host.dispose(); vi.restoreAllMocks(); }
  });
});
