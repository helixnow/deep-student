/** Host 半与 UI 半共用的数据形状（UI 半只做类型导入，构建产物里不出现）。 */
export interface StudyDay {
  /** 本地日期 YYYY-MM-DD。 */
  date: string;
  minutes: number;
}

export const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Host 半发、UI 半收的事件名（`today` 变了）。Host 半用 `pluginEventName(id, TODAY_EVENT)` 组件成完整名字
 * `example/study-goal:today`；UI 半按裸名字订阅，内核按本插件 id 补前缀（docs/plugins/SDK.md §5）。
 */
export const TODAY_EVENT = 'today';
