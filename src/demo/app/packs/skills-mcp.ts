/**
 * 技能与 MCP 扩展（官网 /user-guide/skills-mcp）——占位：尚未写剧本数据，只渲染空的应用窗口。
 */
import type { DemoAppPack } from '../types';

const pack: DemoAppPack = {
  title: '技能与 MCP 扩展',
  load: () => import('@/features/workbench/apps/system/SkillsAppWindow').then((m) => m.default),
};

export default pack;
