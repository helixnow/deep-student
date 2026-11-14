/** Real connection/ACL/contracts and review handler; observe its external service call. */
import { appendFileSync } from 'node:fs';
import { serveHost } from '../../../host/kernel/connection.ts';
import { ContractSet } from '../../../host/kernel/contracts.ts';
import { CapabilityAcl } from '../../../host/kernel/acl.ts';
import { electronParentPortTransport, type ParentPortLike } from '../../../host/kernel/transports.ts';

const parent = (process as unknown as { parentPort: ParentPortLike }).parentPort;
serveHost(await electronParentPortTransport(parent), {
  contracts: () => ContractSet.fromDirectory(process.env.INBOUND_CONTRACTS!),
  acl: () => new CapabilityAcl([
    { identifier: 'inbound-local', local: true, windows: ['main'], permissions: ['allow-inbound'] },
  ], [{ identifier: 'allow-inbound', allow: ['insight_list', 'inbound_echo', 'inbound_error', 'inbound_bytes'], deny: [] }], 'linux'),
  onRuntime(runtime) {
    runtime.ctx.provide('storage', {});
    runtime.ctx.provide('insight', {
      listInsights: (...args: unknown[]) => {
        // Record actual post-contract handler arguments, never the transport's raw text.
        appendFileSync(process.env.INBOUND_CALLS!, JSON.stringify(args.map(value =>
          typeof value === 'bigint' ? { type: 'bigint', decimal: value.toString() } : value)) + '\n');
        return [];
      },
    });
  },
  exit: code => process.exit(code),
});
