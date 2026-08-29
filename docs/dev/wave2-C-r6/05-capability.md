# 0824 Wave2-C R6 · 卡 6「能力分离」复核报告

复核员：能力分离（第 6 轮）　模型：claude-fable-5-thinking-high
工作目录：/tmp/0824-wave2-c-r6-cap（基线 b35038a8，复核前工作树干净）
约束遵守：未执行任何测试/构建；未 git commit；InputBarUI.tsx 与
inputBarCapabilities.ts 逐字未动（只读，卡 1 独占）；仅按授权修了两处骗人注释。

## 结论

三分离契约完好，三个判定各答各的问题，无回归。唯一动作：把
AttachmentPanelBody / ComposerPlusMenu 两处仍写着「pointer: coarse 设备能力」
的 isMobileEnv prop 文档注释改为真实语义（相机捕获能力），逻辑零改动。

## 逐项核验

### 1. 布局 = 宽度断点 ✅

- InputBarUI.tsx:300/327：`isMobile = useMobileLayoutSafe()?.isMobile ?? false`。
- 链路核实：MobileLayoutContext.tsx:52/77 `isMobile: isSmallScreen` ←
  useBreakpoint.ts:53 `isSmallScreen: !isMd` ← `useMediaQuery('(min-width: 768px)')`
  取反。纯宽度驱动，无指针/UA 掺杂。
- 消费面抽查：内联面板门（2141）、桌面 overlay 门（2568/2588/2611/2631/2647）、
  返回键注册（1431/1438）、键盘 inset 焦点门（1072/1097）、底部 gap（1657，
  L7 修复的 `mobileLayout?.isMobile` 依赖仍在，闭包不再捕获初始断点）、
  外壳圆角样式分支（2247）——全部只用 isMobile，未见指针查询兼职布局。

### 2. 触摸 = any-pointer: coarse ✅

- inputBarCapabilities.ts:23 `TOUCH_CAPABILITY_MEDIA_QUERY = '(any-pointer: coarse)'`
  原样在；模块头注释（11-14 行）完整保留「any-pointer vs pointer 只看主指针」论证。
- InputBarUI 全文 grep：无任何 `matchMedia`/`useMediaQuery` 指针查询（源码契约测试
  inputBarCapabilities.test.ts:113 的断言对象仍成立）。JS 侧当前无触摸布尔消费方，
  常量作为唯一入口待命，符合「需要时统一走这里」的约定。
- 样式侧 `[@media(pointer:coarse)]` 类（InputBarUI 2333/2341 等、AttachmentPanelBody
  coarseRowClass）按 R3 决议留在 CSS 媒体查询类体系（卡 1 触控目标卡管辖），
  不属于本卡违规。

### 3. 相机 = 平台/捕获能力 ✅

- InputBarUI.tsx:813 `canCapturePhoto = useMemo(() => detectCanCapturePhoto(), [])`，
  挂载求值一次；导入自 inputBarCapabilities（39 行）。
- inputBarCapabilities.ts:42-43 判定原样：`isAndroid() || isIOS() ||
  (supportsInputCapture() && isMobilePlatform())`。无 enumerateDevices、无指针查询；
  supportsInputCapture 仍是 `'capture' in createElement('input')` 零权限特性检测。
- platform.ts 抽查：isIOS 保留 iPadOS 13+ 桌面模式识别（MacIntel +
  maxTouchPoints>1），isMobilePlatform 同款处理，判定未被后续轮次削弱。
- 两个消费点（2122/2494）仍是 `isMobileEnv={canCapturePhoto}`，与源码契约测试
  （count === 2）一致，且各带「prop 名兼容保留、语义已是相机捕获能力」注释。

## 本轮改动（仅注释，2 处）

isMobileEnv prop 在下游声明处的文档注释仍写「pointer: coarse 设备能力」，
与实际传入值（canCapturePhoto，平台判定）矛盾——正是「prop 名骗人」残留：

1. **AttachmentPanelBody.tsx**（原 59 行）：注释改为「相机捕获能力……上游传入
   inputBarCapabilities.canCapturePhoto()，早已不是 pointer: coarse，prop 名为
   历史遗留，待改名为 canCapturePhoto」。
2. **ComposerPlusMenu.tsx**（原 71 行）：同款改写。

未改 prop 名本身（改名是签名/逻辑变更，超出「可只改注释」授权；InputBarUI 卡 1
独占也不允许同步改调用点）。ComposerToolbar.tsx:252 的 isMobileEnv 无注释、
无谎言，未动。

## 遗留（未处理，非本卡授权范围）

- **prop 改名**：三个下游（AttachmentPanelBody / ComposerToolbar / ComposerPlusMenu）
  的 isMobileEnv → canCapturePhoto 改名 + InputBarUI 调用点同步，需等卡 1 解锁
  InputBarUI 后一并做（R3 已留锚点注释，本轮注释里补了「待改名」标记）。
- **BlockingApprovalBar.tsx:68**：`useMediaQuery('(pointer: coarse)')` 用于折叠
  密度，属触摸语义，按契约应迁 TOUCH_CAPABILITY_MEDIA_QUERY（any-pointer）。
  R3 已记录，至今未迁；改查询字符串是行为变更，超出本卡注释权限，继续挂账。
- 新注释未经 tsc/eslint 验证（本轮禁跑），但均为纯 JSDoc 块注释，语法风险极低。
