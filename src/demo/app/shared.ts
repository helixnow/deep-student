/**
 * 多个剧本包共用的小段 mock。只依赖演示数据模块，不碰 app 模块（见 ./types.ts）。
 */
import { DEMO_ANKI_TEMPLATES } from '../ankiTemplates';
import type { DemoArgs } from './types';

/** Anki 模板三件套：DialogControlProvider、制卡、闪卡库启动时都会查 */
export function handleAnkiTemplates(cmd: string, _args: DemoArgs): unknown {
  switch (cmd) {
    case 'get_all_custom_templates':
    case 'import_builtin_templates':
      return DEMO_ANKI_TEMPLATES;
    case 'get_default_template_id':
      return DEMO_ANKI_TEMPLATES[0]?.id ?? null;
    default:
      return undefined;
  }
}

/** 依次尝试多个处理器，第一个给出结果的生效 */
export function chain(...handlers: Array<(cmd: string, args: DemoArgs) => unknown>) {
  return (cmd: string, args: DemoArgs): unknown => {
    for (const handler of handlers) {
      const result = handler(cmd, args);
      if (result !== undefined) return result;
    }
    return undefined;
  };
}
