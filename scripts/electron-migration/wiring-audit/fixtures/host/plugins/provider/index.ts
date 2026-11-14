import { names, commands } from './meta.ts';
export default {
  meta: { id: 'fixture.provider', lane: 'fixture', provides: [...names], commands, remote: { rpc: ['run'], remoteOnly: ['run'] } },
  inject: [],
  apply() { throw new Error('Audit must not execute apply'); },
};
