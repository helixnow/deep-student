import { createTestHost } from '../../kernel/testing.ts';

// The caller supplies real plugins and deterministic external providers, not business service doubles.
// eventDrain must be a lifecycle terminal signal from the owning plugin; a timeout is not completion.
export async function createCommandHost({ dataDir, plugins, eventDrain }) {
  if (typeof eventDrain !== 'function') throw new Error('command replay requires explicit terminal-event drain');
  const host = await createTestHost({ app: { dataDir }, plugins });
  return { invoke: (command, args) => host.invoke(command, args), events: host.events,
    settle: () => eventDrain(host), close: () => host.dispose() };
}
