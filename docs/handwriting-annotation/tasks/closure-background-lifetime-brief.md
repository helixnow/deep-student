# 来源背景保存后重绘异常 — 最小修复任务

范围：已批准收尾计划内的真实 Android 缺陷修复，不新增功能或存储依赖。子 agent 编写测试／修改；主 agent 独立运行 RED、GREEN、回归、构建和模拟器验收；仅主 agent 本地提交。

## 实际证据

主 agent 在 API36／x86_64 新测试 AVD `emulator-5582` 亲自复现：

- 已准备 PDF：来源固定PNG初显正常；新增笔迹成功提交 page＋manifest，然后 `ErrorBoundary:ink-editor` 记录 DOMException，UI显示“Could not load this page.”。重启后笔迹仍可见。再次新增笔迹同样复现。
- 已准备图片：菜单prepare生成1页image背景成功，新增蓝笔迹提交后同样抛DOMException。
- 不能仅以DB保存成功宣布编辑体验通过，也不能把UI自动化未找到touch开关作为根因。

## 根因与修复约束

保存替换manifest／pageRef引用，触发背景effect清理；旧ImageBitmap被close，但该commit中子组件仍持有旧background prop，后续Canvas drawImage抛InvalidStateError。无源高亮的PDF与图片共同经过rawBitmap路径；既有非空PDF高亮合成Canvas夹具掩盖此问题。

1. 先在真实浏览器CT新增图片／无高亮PDF背景的保存后重绘回归，主agent运行并确认原实现失败。
2. 最小生命周期修复：已发布背景的lease只能在React已替换／解绑其prop后释放；未发布的迟到异步结果取消时立即释放。合成高亮Canvas也必须按同一所有权释放。
3. 保留manifest revision／来源高亮重新取值，不通过去掉依赖、吞异常、跳过背景、setTimeout或无限缓存规避。
4. 保留4MiB／边长2048／16M像素预算和严格native来源闭包，不放宽格式与授权。
5. 保持既有代码风格，不新增运行时依赖，不大重构。

## 验收

- 真实CT对image和无高亮pdf_page：背景可见→画笔→save成功→编辑器继续存在／无error alert；背景与新增笔迹真实像素保留。
- 导航／重开不使用已释放背景；迟到取消结果不泄漏，卸载释放仍保留。
- 原52项完整浏览器＋新增回归，Ink单测／完整前端四片、typecheck、lint棘轮通过。套件重叠数字不叠加。
- 新x86诊断包升级安装，不清测试数据；PDF／图片新增笔迹保存、undo/redo／重启重开；Android问AI生成真实PNG附件，不新增模型请求。
- 主agent审阅并本地fix commit后，重新构建ARM64官方配置测试APK并签名／全部产物guards，不交付已知有此缺陷的首轮包。

子agent不得自行测试、提交、推送、派生agent。报告路径：`tasks/closure-background-lifetime-report.md`。主agent测试日志使用`verification/closure-background-*.log`。
