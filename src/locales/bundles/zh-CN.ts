import { toBundles } from './toBundles';

export default toBundles(
  import.meta.glob<Record<string, unknown>>('../../locales/zh-CN/**/*.json', { eager: true, import: 'default' }),
);
