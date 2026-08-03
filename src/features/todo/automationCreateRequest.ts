/**
 * 定时任务「请求打开创建面板」的共享入口。
 *
 * 命令面板 / 设置区嵌入态可能在自动化工作区尚未挂载时发起请求：
 * 除了派发 window 级 CustomEvent（工作区已挂载时即时响应）外，
 * 还记录 pending 标记，由 TodoAutomationWorkspace 挂载时消费，
 * 避免「先 dispatch、后挂载」时事件丢失。
 */

export const AUTOMATION_REQUEST_CREATE_EVENT = 'automation:request-create';

let pendingCreateRequest = false;

/** 请求打开创建面板：立即派发事件并记录 pending 标记。 */
export function requestAutomationCreate(): void {
  pendingCreateRequest = true;
  window.dispatchEvent(new CustomEvent(AUTOMATION_REQUEST_CREATE_EVENT));
}

/** 消费未处理的创建请求（工作区挂载或收到事件时调用），返回是否曾有请求。 */
export function consumePendingAutomationCreate(): boolean {
  const pending = pendingCreateRequest;
  pendingCreateRequest = false;
  return pending;
}
