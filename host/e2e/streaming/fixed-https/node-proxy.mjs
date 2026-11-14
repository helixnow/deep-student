// Import only in the disposable B Host process, before loading production code.
// undici is an existing dependency; fetch remains the runtime's real fetch.
import { readFileSync } from 'node:fs';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

if (!process.env.X5_ILINK_PROXY || !process.env.X5_ILINK_CA) {
  throw new Error('x5 iLink: launch through run.ts; proxy and CA are required');
}
const dispatcher = new ProxyAgent({ uri: process.env.X5_ILINK_PROXY,
  requestTls: { ca: readFileSync(process.env.X5_ILINK_CA), rejectUnauthorized: true } });
setGlobalDispatcher(dispatcher);
