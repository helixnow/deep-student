export default {
  meta: { id: 'audit.fixture', lane: 'X2-test', commands: ['fixture_load'] },
  apply() { throw new Error('Metadata probing must never start plugin services'); },
};
