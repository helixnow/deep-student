/**
 * 第 15 章「技能与 MCP 扩展」：技能管理窗口。50 多个内置技能之外，全局目录里有三个技能——
 * 自己写的「考研数学错题教练」、从社区市场装的「英语长难句拆解」（都已信任）和
 * 刚装还没信任的「有机化学反应机理」。新建 / 编辑 / 停用 / 信任 / 删除、社区技能市场
 * 搜索与安装都在内存里生效；GitHub 技能源、导入 zip 提示去桌面版。
 * （MCP 服务器在设置窗口的「MCP 工具」页，不在本窗口。）
 */
import type { DemoAppPack } from '../types';
import { DEMO_SKILL_LOCAL_STORAGE, handleDemoSkills, isDemoUserSkill } from './skills-mcp/backend';

const pack: DemoAppPack = {
  title: '技能与 MCP 扩展',
  load: () => import('./skills-mcp/SkillsWindow').then((m) => m.default),
  handle: handleDemoSkills,
  localStorage: DEMO_SKILL_LOCAL_STORAGE,
  namespaces: ['skills', 'workbench', 'mcp', 'settings', 'app_menu'],
  async prepare() {
    // 技能名 / 描述一律先查 skills:builtinNames.<id>（带空 defaultValue，查不到回退 SKILL.md 里的值）。
    // 对非内置技能这是设计内的回退，不是漏文案：别让烟测把它们记成缺失。
    const { default: i18n } = await import('@/i18n');
    const report = i18n.options.missingKeyHandler;
    if (typeof report !== 'function') return;
    const fallbackKey = /^builtin(Names|Descriptions)\.(.+)$/;
    i18n.options.missingKeyHandler = (lngs, ns, key, ...rest) => {
      const m = ns === 'skills' ? fallbackKey.exec(key) : null;
      if (m && isDemoUserSkill(m[2])) return;
      report(lngs, ns, key, ...rest);
    };
  },
};

export default pack;
