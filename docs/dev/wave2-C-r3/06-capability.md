# 0824 Wave2-C R3 · 卡 6「能力分离」产出报告

模型：claude-fable-5-thinking-high　基线：e90fb360　工作目录：/tmp/0824-wave2-c-r3-capability
约束遵守：未跑任何 npm/node/vite/vitest；未 git commit；未改 ComposerPlusMenu.tsx / AttachmentPanelBody.tsx；未触碰 isWithinComposerTerritory / pointerdown 外点 / back handler（第 2 轮逻辑，diff 已核对零命中）。

## 问题

InputBarUI 里 `isMobileEnv = useMediaQuery('(pointer: coarse)')` 一个布尔同时兼任
「移动环境 / 触摸 / 相机」三个语义，实际下游（AttachmentPanelBody、
ComposerToolbar→ComposerPlusMenu）只用它控制拍照入口。后果：

- 桌面触摸屏（Surface 台式机等）主指针 coarse → 误出「拍照」入口，唤起后退化成普通文件选择器；
- 手机/平板外接键鼠时主指针变 fine → 真有摄像头的设备漏掉「拍照」入口；
- `pointer: coarse` 只看主指针，判「触摸能力」本身也不准（应为 any-pointer）。

## 三分离方案（P4）

| 问题 | 判定 | 落点 |
|---|---|---|
| 布局 | `isMobile`（MobileLayoutContext 宽度断点） | 不变，仍是一切布局分支唯一依据 |
| 触摸 | `(any-pointer: coarse)` | 新常量 `TOUCH_CAPABILITY_MEDIA_QUERY`；JS 侧触摸布尔统一走它，样式侧 CSS 媒体查询类不动 |
| 相机 | `canCapturePhoto()`：`isAndroid() || isIOS() || (supportsInputCapture() && isMobilePlatform())` | 替换原 isMobileEnv，只喂拍照入口 |

相机判定刻意不用 `enumerateDevices()`（部分平台触发权限弹窗）、不用指针媒体查询
（触摸 ≠ 有摄像头）。`supportsInputCapture()` 是 `'capture' in createElement('input')`
纯特性检测，零权限副作用；兜底分支叠加 `isMobilePlatform()` 门控，因为桌面浏览器
即使实现 capture 属性也只会退化成文件选择器。

## 改动清单

1. **src/features/chat/components/input-bar/InputBarUI.tsx**（独占文件）
   - 删除 `useMediaQuery('(pointer: coarse)')` 与其导入；`isMobileEnv` 标识符在本文件消亡。
   - 新增 `const canCapturePhoto = useMemo(() => detectCanCapturePhoto(), [])`
     （从 inputBarCapabilities 导入；平台检测会话内不变，挂载求值一次）。
   - 两个下游消费点改为 `isMobileEnv={canCapturePhoto}`：prop 名保持兼容
     （AttachmentPanelBody / ComposerToolbar→ComposerPlusMenu 本轮卡 5 独占锁，
     不能改签名），传入的 boolean 已是纯相机能力，附注释说明语义。
   - 顶部 A-6/P1-6 语义注释更新为三分离版本。
2. **src/features/chat/components/input-bar/inputBarCapabilities.ts**（新建）
   - `TOUCH_CAPABILITY_MEDIA_QUERY` / `supportsInputCapture()` / `canCapturePhoto()`，
     模块头注释完整记录三分离契约与「为什么不用 enumerateDevices / pointer 查询」。
3. **src/utils/platform.ts**
   - 按任务授权新增 `isIOS()`：UA/platform 匹配 iphone|ipad|ipod + iPadOS 13+
     桌面模式（MacIntel + maxTouchPoints>1，与既有 isMobilePlatform 同款处理）。
4. **__tests__/inputBarCapabilities.test.ts**（新建，只写未跑）
   - 单测：Android/iOS 直接放行；桌面 + capture 特性仍为 false（移动壳门控）；
     移动壳 + capture 特性放行。平台 mock 走 `@/utils/platform`，capture 支持用
     prototype defineProperty 模拟（jsdom 不实现该属性）。
   - 源码契约：能力模块无 enumerateDevices、无 `'(pointer: coarse)'`；触摸常量
     等于 `(any-pointer: coarse)`；InputBarUI 不再声明 `const isMobileEnv`，两个
     `isMobileEnv={canCapturePhoto}` 消费点齐备；`isMobile` 断点声明仍在。
5. **__tests__/InputBarUI.appMenuOutsideClick.pointer.test.tsx**（配套修，未动第 2 轮断言）
   - 原先靠 mock `useMediaQuery('(pointer: coarse)')=true` 让「拍照」菜单项出现；
     三分离后该路径失效（jsdom UA 非 Android/iOS）。改为 mock
     `../inputBarCapabilities` 的 `canCapturePhoto → true`（importOriginal 保留其余导出）。
     外点判定、pointerdown 链路、source 契约等卡 1/卡 2 断言逐字未动。

## 行为变化

- 桌面触摸屏（宽屏 + coarse 主指针 + 非移动 UA）：拍照入口从「误出现」→ 不出现。
- Android/iOS 外接键鼠（fine 主指针）：拍照入口从「漏掉」→ 出现。
- 其余全部路径（布局分支、触摸命中区 CSS、外点/返回键）：零变化。

## 风险与遗留

- ComposerPlusMenu/AttachmentPanelBody 的 prop 名与 doc 注释仍写着
  「pointer: coarse 设备能力」，本轮独占锁不可改；建议卡 5 解锁后把 prop 重命名为
  `canCapturePhoto` 并同步注释（InputBarUI 侧已留好注释锚点）。
- BlockingApprovalBar 自己的 `useMediaQuery('(pointer: coarse)')`（折叠密度用途）
  属触摸语义，按 P4 应迁 any-pointer，但该文件非本轮独占，未动。
- 新测试均未执行（本轮禁跑）；`vi.fn` 采用无泛型推断写法以兼容 vitest 3。
