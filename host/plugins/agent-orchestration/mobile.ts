/**
 * 移动端入口：没有同步本地文件系统，自定义子智能体人设（agents/ 目录）按“不可用”降级；
 * 待办、super session 等基于 SQLite 的能力与桌面一致。自动化调度器需要 `dstu.shell` 的启动门
 * （启动恢复 + 15s tick），移动端关闭，自动化命令面照常注册。
 */
import { createAgentOrchestrationPlugin } from './src/plugin.ts';

export type { AgentOrchestrationPluginOptions } from './src/plugin.ts';

export default createAgentOrchestrationPlugin({ platforms: ['mobile'], automationScheduler: 'off' });
