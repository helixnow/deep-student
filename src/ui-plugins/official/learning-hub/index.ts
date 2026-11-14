import { defineUiPlugin } from '@/ui-kernel/kernel';
import { contributeCommands } from '@/command-palette/contribute';
import { learningCommands } from '@/command-palette/modules/learning.commands';
import { OFFICIAL_RESOURCE_TYPES, OFFICIAL_RESOURCE_TYPE_IDS } from '@/shared/resource-types/official';
import '@/shared/resource-types/contracts';

/**
 * `resource.types` 的官方宿主：声明 keyed 槽位并贡献 8 个内置类型。
 * 槽位不进 `BUILTIN_SLOTS`，卸载本插件即撤销类型表；消费者无内核时回落同一份静态表。
 */
export const RESOURCE_TYPES_SLOT = {
  name: 'resource.types',
  cardinality: 'keyed',
  description: '资源类型：key = 类型 id；声明单数名称、预览与支持的操作（W17 ui-runtime §4）',
} as const;

/** Learning Hub commands (translation and essay grading) + the official resource type table. */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.learning-hub', slots: ['resource.types'] },
  apply(ctx) {
    contributeCommands(ctx, () => learningCommands);
    ctx.ui.declareSlot(RESOURCE_TYPES_SLOT);
    for (const type of OFFICIAL_RESOURCE_TYPE_IDS) {
      const definition = OFFICIAL_RESOURCE_TYPES[type];
      ctx.ui.contribute('resource.types', {
        id: `resource-type:${type}`,
        key: type,
        order: definition.order,
        value: definition,
      });
    }
  },
}), { order: 150 });
