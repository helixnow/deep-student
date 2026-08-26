# Wave2-B 第 2 轮「回滚 UI」i18n 键清单

范围：仅 `src/locales/zh-CN/workbench.json` 与 `src/locales/en-US/workbench.json`。
未改动任何 ts/tsx 逻辑文件；未改动 settings namespace（经 grep 确认 workbenchMode
相关文案全部落在 `workbench` namespace，如 `workbench:settings.mode.migratedNotice`，
见 `src/features/settings/components/workbenchMode.ts`）。

## 本轮新增键（workbench namespace）

| 键 | zh-CN | en-US |
| --- | --- | --- |
| `deactivation.cancelled` | 已取消停用，学习桌面保持开启。 | Deactivation cancelled. Study Desktop stays on. |
| `deactivation.dirtyBlocked` | 存在未保存的窗口，已取消关闭学习桌面，请先保存或关闭这些窗口。 | Some windows have unsaved changes, so closing Study Desktop was cancelled. Save or close those windows first. |
| `deactivation.exitBlocked` | 存在未保存的内容，已取消退出，请先保存后再退出。 | There is unsaved content, so exiting was cancelled. Save your work before quitting. |
| `suspend.keptBackground` | 该窗口有未保存的内容，已保留在后台运行，未被冻结。 | This window has unsaved changes, so it was kept running in the background instead of being frozen. |
| `hub.closeCancelled` | 已取消关闭标签页，未保存的内容仍保留。 | Closing the tab was cancelled. Your unsaved changes are kept. |

注：截至本轮，以上键在代码中尚无引用（实现员的引用改动尚未合入本分支），属预置占位；
键路径与实现约定一致，落地后即可命中。

## 复用声明（未新增，避免重复死键）

Learning Hub 关标签场景中，以下两个约定键 **复用既有 `content.*` 键**，未在 `hub` 组下重复造键：

- `hub.closeUnsaved` → 复用 `workbench:content.confirmCloseUnsaved`
  （zh：「当前内容有未保存的修改，确定要关闭窗口吗？」/ en："This content has unsaved changes. Close the window anyway?"）。
  若实现时希望措辞贴合“标签页”而非“窗口”，可参考既有 `workbench:notesWorkspace.confirmCloseUnsaved`
  （「此标签页有未保存的更改，确定要关闭吗？」）的写法再议，不在本轮擅自新增。
- `hub.saveAndClose` → 复用 `workbench:content.saveAndClose`（「保存并关闭」/ "Save & Close"）。

相关既有键（已被 `createContentApp.tsx`、`content/register.ts`、`notes/register.ts`、
`ContentCloseConfirmation.tsx` 等引用，保持不动）：

- `content.confirmCloseUnsaved`
- `content.saveAndClose`
- `content.saveAndCloseFailed`

## 本域疑似死键（workbench.json 有、代码零引用）

扫描方法：对 zh-CN/workbench.json 全部 943 个叶子键做全路径 fixed-string 检索
（排除 `src/locales`），无命中者再做两轮复核：① 父路径动态拼接
（如 `agent.errors.${code}`、`agentControlCenter.apps.${id}`、`devPanel.lifecycle.${state}`
均确认为动态引用，不算死键）；② 末段独立 grep 全仓库（排除 locales/docs）。
两轮均零命中的列为疑似死键。**本轮未删除任何键**，仅记录：

- `agent.apps.reserved`（值为占位 "-"）
- `menubar.openCommandPalette`、`menubar.centerShort`、`menubar.moduleFlashcards`、
  `menubar.moduleTasks`、`menubar.moduleFocus`、`menubar.moduleDesktop`、
  `menubar.desktopHint`、`menubar.tasksRunningShort`
- `dock.noWindows`
- `resourceHome.loadFailed`、`resourceHome.tryAnotherSearch`、`resourceHome.createHint`、
  `resourceHome.emptyQuestionSet`、`resourceHome.notGraded`、`resourceHome.openHint`
- `emptyDesktop.actionFilesDesc`、`emptyDesktop.actionApps`、`emptyDesktop.actionFlashcards`、
  `emptyDesktop.actionChat`、`emptyDesktop.actionChatDesc`、`emptyDesktop.actionTodo`、
  `emptyDesktop.actionTodoDesc`、`emptyDesktop.tipsTitle`、`emptyDesktop.tipsDismiss`、
  `emptyDesktop.tipTile`、`emptyDesktop.tipSwitch`、`emptyDesktop.tipExpose`
- `files.dragOut.openOnDesktop`（仅 docs 提及）
- `a11y.windowOpened`（仅 docs 提及；a11y 播报键，删除前需与无障碍清单
  `docs/dev/workbench-a11y-checklist.md` 对账）
- `settings.browserPolicyDisabled`
- `browser.blockedScheme`、`browser.needWorkbench`、`browser.needBrowserEnabled`、
  `browser.contentCrashed`、`browser.approveNavigate`、`browser.approveClick`、`browser.approveType`
- `devPanel.dropped`
- `notesWorkspace.emptyPane`、`notesWorkspace.ribbon.aria`、`notesWorkspace.ribbon.explorer`、
  `notesWorkspace.explorer.open`、`notesWorkspace.navHistory.aria`、`notesWorkspace.navHistory.back`、
  `notesWorkspace.navHistory.forward`、`notesWorkspace.dialog.renameTitle`、
  `notesWorkspace.dialog.nameLabel`、`notesWorkspace.dialog.rename`
- `resourceWorkspace.hideSidebar`

末段为常用词（`open`/`close`/`zoom`/`hint`/`empty`/`startReview`/`expose` 等）
无法排除动态或相对键引用的条目，已从上表剔除，不作死键结论。
