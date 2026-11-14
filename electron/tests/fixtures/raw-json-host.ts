/** Real kernel connection/commands/events; release-mode mixed typed non-finite coverage.
 * The fixture only selects profile/contracts and debug mode, never rewrites outbound values. */
import { serveHost } from '../../../host/kernel/connection.ts';
import { ContractSet } from '../../../host/kernel/contracts.ts';
import { electronParentPortTransport, type ParentPortLike } from '../../../host/kernel/transports.ts';

const parent = (process as unknown as { parentPort: ParentPortLike }).parentPort;
const transport = await electronParentPortTransport(parent);
serveHost({
  ...transport,
  onMessage(listener) {
    transport.onMessage(message => {
      if (message !== null && typeof message === 'object' && (message as { kind?: unknown }).kind === 'handshake') {
        listener({ ...message, debug: false });
      } else listener(message);
    });
  },
}, {
  contracts: () => ContractSet.fromDirectory(process.env.RAW_JSON_CONTRACTS!),
  exit: code => process.exit(code),
});
