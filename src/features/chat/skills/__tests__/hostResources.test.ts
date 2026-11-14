import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillRegistry } from '../registry';
import { ensureHostSkillContent, hostSkillSchemaToolIds, registerHostSkill, restoreHostSkillSummaries } from '../hostResources';

describe('Host-shipped workshop skill', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => { unregister?.(); });
  it('keeps only resource metadata resident, loads the real body on activation, and scopes schema IDs', async () => {
    const markdown = readFileSync('resources/dstu-workshop/skills/dstu-plugin-development/SKILL.md', 'utf8');
    const id = 'dstu-plugin-development';
    const schemaToolIds = ['api_list', 'api_read', 'validate', 'propose_install', 'status', 'export'].map(name => `dstu_plugin_${name}`);
    const metadata = markdown.slice(0, markdown.indexOf('\n---', 3) + 4) + '\n';
    const read = vi.fn(async () => ({ id, markdown, schemaToolIds }));
    unregister = registerHostSkill({ id, markdown: metadata, schemaToolIds }, read);
    expect(read).not.toHaveBeenCalled();
    expect(skillRegistry.get(id)?.content).toBe('');
    expect(skillRegistry.getAllMetadata().find(skill => skill.id === id)?.description).toContain('dstu plugin');
    expect(hostSkillSchemaToolIds(['tutor-mode'])).toEqual([]);
    await ensureHostSkillContent(id);
    expect(read).toHaveBeenCalledTimes(1);
    expect(skillRegistry.get(id)?.content).toContain('user Create click');
    expect(hostSkillSchemaToolIds([id])).toEqual(schemaToolIds);
    await ensureHostSkillContent(id);
    expect(read).toHaveBeenCalledTimes(1);
    skillRegistry.unregister(id);
    restoreHostSkillSummaries();
    expect(skillRegistry.has(id)).toBe(true);
    unregister();
    expect(skillRegistry.has(id)).toBe(false);
    expect(hostSkillSchemaToolIds([id])).toEqual([]);
  });
});
