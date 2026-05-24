import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 group sync contract', () => {
  it('emits a global group update event after group mutations', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/chat-v2/hooks/useGroupManagement.ts'), 'utf-8');

    expect(source).toContain("new CustomEvent('chat-v2:groups-updated')");
  });

  it('refreshes the modern sidebar when group updates are emitted', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/components/ModernSidebar.tsx'), 'utf-8');

    expect(source).toContain("type: 'chat-v2:groups-updated'");
  });
});
