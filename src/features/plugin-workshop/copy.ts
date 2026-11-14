import type { WorkshopAction, WorkshopPhase } from './types';

export const phaseLabels: Record<WorkshopPhase, string> = {
  proposed: '等待创建确认', ready: '等待安装确认', generating: '正在生成', validating: '正在检查', installing: '正在安装',
  installed: '已安装', disabled: '已安装 · 未启用', undone: '已撤销', cancelled: '已取消', failed: '失败',
};
export const actionLabels: Record<WorkshopAction, string> = {
  confirm: '创建/安装', cancel: '取消', try: '试用', disable: '停用', undo: '撤销', restore: '恢复', export: '导出 .dstuplugin',
};
export const fullTrustNotice = '工坊作品默认完全信任：与应用在同一进程运行，拥有与官方插件同等的能力，可能访问本机数据。仅在理解这些能力与风险后创建/安装。';
