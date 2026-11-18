import { toBundles } from './toBundles';

export default toBundles(
  import.meta.glob<Record<string, unknown>>('../../locales/en-US/**/*.json', { eager: true, import: 'default' }),
);
