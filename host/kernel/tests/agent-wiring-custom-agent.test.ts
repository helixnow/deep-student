import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CHATANKI_READONLY_TOOLS, findCustomProfile, safeToolSet } from '../../plugins/agent-workspace/api.ts';
import { createChatAnkiExecutors } from '../../plugins/chatanki/api.ts';

// src/agent_wiring/tests/custom_agent_tests.rs:21-57. Both providers are the
// public production implementations; metadata queries need no service doubles.
it('chatanki_readonly_tools_are_allowed_and_low_sensitivity', () => {
  const safe = safeToolSet();
  for (const tool of CHATANKI_READONLY_TOOLS) expect(safe.has(tool), tool).toBe(true);

  // L24 splits the Rust executor; use its production first-match dispatch order.
  const executors = createChatAnkiExecutors();
  for (const tool of CHATANKI_READONLY_TOOLS) {
    const executor = executors.find(candidate => candidate.canHandle(tool));
    expect(executor, tool).toBeDefined();
    expect(executor!.sensitivityLevel(tool), tool).toBe('low');
  }

  const dir = mkdtempSync(join(tmpdir(), 'dstu-agent-wiring-custom-'));
  try {
    writeFileSync(join(dir, 'qa-readonly.md'), '---\nname: qa-readonly\nbase: worker\ntools: [builtin-chatanki_get_cards, builtin-chatanki_status, builtin-chatanki_analyze, builtin-chatanki_list_templates]\n---\nBody.\n');
    const profile = findCustomProfile(dir, 'qa-readonly');
    expect(profile).not.toBeNull();
    expect(profile!.allowedTools).toEqual([
      'builtin-chatanki_get_cards', 'builtin-chatanki_status',
      'builtin-chatanki_analyze', 'builtin-chatanki_list_templates',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
