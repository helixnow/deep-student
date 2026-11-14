/** Real kernel/MessagePort; record incoming shell-result and post-settle pending count. */
import { appendFileSync } from 'node:fs';
import { serveHost } from '../../../host/kernel/connection.ts';
import { ContractSet } from '../../../host/kernel/contracts.ts';
import { CapabilityAcl } from '../../../host/kernel/acl.ts';
import { electronParentPortTransport, type ParentPortLike } from '../../../host/kernel/transports.ts';

const parent = (process as unknown as { parentPort: ParentPortLike }).parentPort;
const transport = await electronParentPortTransport(parent);
let pendingCount = () => -1;
const record = (value: unknown) => appendFileSync(process.env.BROWSER_ERROR_WIRE!, JSON.stringify(value) + '\n');
serveHost({
  ...transport,
  onMessage(listener) {
    transport.onMessage(message => {
      if (message !== null && typeof message === 'object' && 'kind' in message && message.kind === 'shell-result') record(message);
      listener(message);
    });
  },
  send(message) {
    if (message.kind === 'result') record({ kind: 'settled', id: message.id, ok: message.ok, pending: pendingCount() });
    transport.send(message);
  },
}, {
  contracts: () => ContractSet.fromDirectory(process.env.BROWSER_ERROR_CONTRACTS!),
  acl: () => new CapabilityAcl([
    { identifier: 'browser-error-local', local: true, windows: ['main'], permissions: ['allow-probe'] },
  ], [{ identifier: 'allow-probe', allow: ['browser_error_probe'], deny: [] }], 'linux'),
  onRuntime(runtime) { pendingCount = () => runtime.shell._pending.size; },
  exit: code => process.exit(code),
});
