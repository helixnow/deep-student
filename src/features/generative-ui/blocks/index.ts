/**
 * Generative UI — 内置块注册（import 即注册）
 */

import { generativeUIRegistry } from '../registry';
import {
  statCardPropsSchema,
  alertBlockPropsSchema,
  listBlockPropsSchema,
  progressBlockPropsSchema,
  actionBarPropsSchema,
  textBlockPropsSchema,
  keyValueGridPropsSchema,
} from '../schema';
import { StatCardBlock } from '../components/StatCardBlock';
import { AlertBlock } from '../components/AlertBlock';
import { ListBlock } from '../components/ListBlock';
import { ProgressBlock } from '../components/ProgressBlock';
import { ActionBarBlock } from '../components/ActionBarBlock';
import { TextBlock } from '../components/TextBlock';
import { KeyValueGridBlock } from '../components/KeyValueGridBlock';

generativeUIRegistry.register({
  type: 'stat-card',
  component: StatCardBlock,
  propsSchema: statCardPropsSchema,
  description: '指标卡片：标题、数值、可选趋势',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'alert',
  component: AlertBlock,
  propsSchema: alertBlockPropsSchema,
  description: '提示条：info/warning/destructive',
});

generativeUIRegistry.register({
  type: 'list',
  component: ListBlock,
  propsSchema: listBlockPropsSchema,
  description: '列表：标题 + 条目（label/description/badge）',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'progress',
  component: ProgressBlock,
  propsSchema: progressBlockPropsSchema,
  description: '进度条：current/total',
});

generativeUIRegistry.register({
  type: 'action-bar',
  component: ActionBarBlock,
  propsSchema: actionBarPropsSchema,
  description: '操作栏：仅声明 action id，副作用由 handler 执行',
});

generativeUIRegistry.register({
  type: 'text',
  component: TextBlock,
  propsSchema: textBlockPropsSchema,
  description: '文本块：heading + body，SaaS 信息密度',
  allowPartialRender: true,
});

generativeUIRegistry.register({
  type: 'key-value-grid',
  component: KeyValueGridBlock,
  propsSchema: keyValueGridPropsSchema,
  description: '键值对网格：摘要/metadata',
});

export {
  StatCardBlock,
  AlertBlock,
  ListBlock,
  ProgressBlock,
  ActionBarBlock,
  TextBlock,
  KeyValueGridBlock,
};
