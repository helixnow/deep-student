# 0824 Wave2-C R1 扫描台账 — 44px 触控目标现状(09-touch-44)

- 角色:扫描员-44px现状 / 只静态审阅,未执行任何构建、测试
- 日期:2026-08-26
- 结论先行:**全库已有 ~4000 处 `[@media(pointer:coarse)]` 散点补丁,根因是 DsButton primitive 的尺寸门槛是视口断点(`lg:`)而不是指针类型(`pointer:coarse`)**。coarse 保证下沉进 `buttonPrimitiveContract.ts` 一处,可让绝大多数 `!min-h-11` 覆盖在机制层面失去存在必要。本轮只记台账,不派散点小修。

---

## 1. 全库统计表(grep 粗计数,src/ 下)

### 1.1 总量

| 模式 | 计数 | 口径 |
|---|---|---|
| `[@media(pointer:coarse)]` 变体出现次数 | **4079** | `rg -o` 逐次 |
| 含 `pointer:coarse` 的行数 | 2878 | `rg -c` 行计 |
| `any-pointer:coarse` | **0** | 全库未用 |
| `min-h-11`(含 `!`) | 2126 | 其中 `!min-h-11` 1348;coarse 门控的 `[@media(pointer:coarse)]:!min-h-11` 1335 |
| `min-w-11`(含 `!`) | 333 | 其中 `!min-w-11` 273 |
| `[@media(pointer:coarse)]:!h-11`(强制实体 44 高) | 448 | |
| `after:-inset` 伪元素扩区 | 146 | |
| `before:-inset` 伪元素扩区 | 23 | |
| 伪元素扩区涉及文件数 | 81 | |
| **未套 coarse 门控的裸 `-inset` 扩区行** | **25** | 桌面鼠标也被扩区,如 `FinderFileItem.tsx:344`、`TodoAppWindow.tsx:93`、`TabBar.tsx:286/306` |
| `COARSE_HIT` 常量引用 | 38(定义 5 处) | 见 §1.3 |
| `h-8` 与 coarse 同行(视觉 32 + coarse 补丁) | 216 | |
| `h-9` 与 coarse 同行(36 + 补丁) | 75 | |
| `h-10` 与 coarse 同行(40 + 补丁) | 44 | |
| `h-8 w-8` 图标按钮总数 | 57(其中 11 行带 coarse 补丁) | |

### 1.2 按目录分布(coarse 行数 / min-h-11 / -inset 扩区)

| 目录 | pointer:coarse | min-h-11 | after/before:-inset |
|---|---|---|---|
| chat(features/chat) | 487 | 329 | **95**(全库最重) |
| settings(features/settings) | 486 | 440 | 8 |
| learning-hub | 272 | 162 | 21 |
| qbank(components/practice + QuestionBank* + ExamContentView) | 174 | 91 | 少量 |
| anki(features/anki + anki-tasks + flashcards) | 92 | 66 | ~2 |
| workbench | 28 | 22 | 1 |
| —— 任务清单之外但量大 —— | | | |
| src/components(共享层,含 translation/essay-grading/ui) | 700 | 446 | 19 |
| debug-panel | 389 | 385 | 0 |
| todo | 142 | 71 | 2 |
| mindmap | 64 | 34 | 10 |

注:features/anki 本体 0(纯逻辑),coarse 集中在 anki-tasks 与 flashcards;qbank 散在 src/components/practice 与 learning-hub ExamContentView,无独立目录。

### 1.3 COARSE_HIT 常量(重复定义,参数不一致)

5 个文件各自私有定义,inset 量还不一样:

- `src/components/translation/TranslationMain.tsx:94` → `-inset-1.5`
- `src/components/translation/TargetPanel.tsx` / `SourcePanel.tsx` / `ComparisonView.tsx`(同族)
- `src/components/essay-grading/InputPanel.tsx:42` → `-inset-2`(另有 COARSE_HIT_SM 变体,见 ROUND-22/23)

ComposerToolbar 又自造了三档:`coarseHitAreaClass`(-inset-1)/`Lg`(-inset-2)/`Xl`(-inset-2.5)。**同一机制至少 8 份拷贝、4 种参数,无共享出口**——这是「体系化」最直接的证据点。

---

## 2. 伪元素扩区 vs 实体 44×44:分布与重叠风险(P3)

两种流派并存:

- **实体流**:`[@media(pointer:coarse)]:!min-h-11 / !h-11 / !w-11`(约 1300–1800 处),真实盒子撑到 44,布局挤占真实空间,但命中区绝不重叠。
- **伪元素流**:`relative + after/before:absolute -inset-N`(169 处 / 81 文件),视觉不变、命中外扩,**相邻扩区可互相覆盖**。

### P3 重叠风险点(只记录,不派修)

1. **ComposerToolbar 右侧行**(`features/chat/components/input-bar/ComposerToolbar.tsx`):容器 `gap-2`(8px),水位环 `after:-inset-2`(两侧各 8px)+ 推理触发器 `coarseHitAreaLgClass`(-inset-2)→ 相邻两扩区在 coarse 下**完全重叠约 8px**,后渲染者盖前者。
2. **ComposerToolbar 左侧行**:`gap-1.5`(6px)+ `coarseHitAreaClass`(-inset-1,两侧共 8px)→ 重叠 2px,轻度。
3. **ContextUsagePopover 双重扩区**(`ContextUsagePopover.tsx:90` + `ComposerToolbar.tsx:211`):AppMenuTrigger 外壳 span `after:-inset-2`,内部 ContextWindowUsageRing span 又叠一层 `after:-inset-2`。两层伪元素几乎同框(内层 h-8 w-7 → 48×44,外层再扩),冗余且外层把命中边界又推大一圈,与相邻推理触发器扩区叠加。
4. **mindmap OutlineNodeMenu / FormatBar**:18–24px 微控件密排 + `-inset-2.5`(外扩 10px),行内多按钮扩区互噬。
5. **未门控裸扩区(25 行)**:`FinderFileItem.tsx:344`(`before:-inset-2` 无 coarse 条件)、`TodoAppWindow.tsx:93`、`TabBar.tsx:286/306` 等——桌面鼠标命中区也被放大,悬停/点击边界与视觉不符。
6. **已知的正确处理先例**:`TabBar.tsx:239` 用 `z-[1]` 显式仲裁重叠热区;`TodoIconRail.tsx:55` 注释明确「放大真实尺寸而非 after:-inset(避免热区互相覆盖)」——说明团队已意识到伪元素流的重叠问题,但没有机制阻止新增。

---

## 3. DsButton / DsDialog 现状与下沉可行性

### 3.1 DsButton(`src/components/ui/DsButton.tsx` + `buttonPrimitiveContract.ts`)

- **默认已是 44——但门槛错了**。`buttonSizeClassNames` 全部尺寸(sm/md/lg/icon/default)基线为 `h-[var(--touch-target-size)]`(=`--control-height-touch`=44px,`shadcn-variables.css:41`),再用 `lg:h-[var(--button-height)]` 在 **≥1024px 视口**压回桌面 32px。
- **关键缺口:压缩条件是 `lg:`(视口宽)而非 `pointer:coarse`(指针类型)**。iPad 横屏(≥1024)、触屏笔记本等 coarse 设备拿到的是 32px。这正是全库 1335 处 `[@media(pointer:coarse)]:!min-h-11` 逐点覆盖的根因——每个调用点都在手工补 primitive 没给的保证。
- primitive 内部对 coarse 的唯一引用是 `ui-press-coarse` 按压动效(注释行),**尺寸层零 coarse 规则**。
- **连设计系统自己都在打补丁**:`DsDialog.tsx:504/523` DsAlertDialog 的取消/确认按钮各挂一条 `[@media(pointer:coarse)]:!min-h-11`——DS 组件消费 DS primitive 还要自救,证明缺口在 primitive。
- **下沉可行性:高,且视觉/命中可分离**。方案:在 `buttonSizeClassNames` / `buttonIconSizeClassNames` 的 `lg:` 压缩后追加 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`(iconOnly 加 `min-w`)。用 `min-h` 而非 `h`,不动桌面 fine 指针视觉;coarse 大屏上按钮实体变高属预期(Apple/Material 均如此)。若个别工具栏(如 FinderToolbar 标题栏 40px 约束)不容实体撑高,可给 primitive 加一档 `hitArea="pseudo"`(内置统一的 coarse 伪元素扩区,替代 8 份私有 COARSE_HIT)。
- 风险:WRAP-UP 记录 PR #172 刻意「`buttonPrimitiveContract.ts` 未改」,即此文件是契约冻结区,改动须带契约测试同步更新(19 项契约测试);另 1335 处既有 `!min-h-11` 覆盖在下沉后变冗余但**无害**(同值),可留给后续 codemod 批量清除,不构成下沉阻塞。

### 3.2 DsDialog(`src/components/ui/DsDialog.tsx`)

- 关闭按钮已内置双形态 coarse 处理(`:263-264`):mobile sheet 实体 `h-11 w-11`;桌面窗体 `w-6 h-6` + `[@media(pointer:coarse)]:!h-11 !w-11 !top-0 !right-0`——**视觉 24px 与命中 44px 分离的正确范本,且封装在组件内,消费方零负担**。这就是「下沉」要复制的形态。
- 缺口仅剩 DsAlertDialog 底部按钮的两条 `!min-h-11` 补丁(§3.1),DsButton 下沉后可直接删除。
- sheet 拖拽把手区 `h-6`(24px)偏小,但为整宽条带 + 手势由 framer drag 接管,属可接受折衷,记录不派修。

### 3.3 组件覆盖面

`<DsButton` 2165 处 / 376 文件;裸 `<button` 仍有 120 处(lint 已 warn)。下沉进 primitive 一次性覆盖 2165 个调用点,是任何散点修法覆盖率的上限。

---

## 4. lint 规则草案:`ds-components/coarse-touch-target`(warn + 白名单)

现有接线(可直接复用):`eslint.config.js:23-29` 以内联 plugin 对象注册 `ds-components/*`,规则文件放 `eslint-rules/`(该目录本身在 eslint ignore 内,规则以 ESM default export)。`no-arbitrary-font-size` 已示范「字符串字面量/模板串正则扫 className」的实现模式和「全局 warn + 特定目录升 error」的分级模式,新规则照抄骨架即可。

**规则意图**:coarse 触控保证必须走体系出口(DsButton 默认 / 共享 COARSE_HIT util / .touch-row 类),禁止调用点手写 `[@media(pointer:coarse)]` 任意变体。

草案要点:

1. **检测**:字符串字面量与模板串中匹配 `/\[@media\((any-)?pointer:coarse\)\]:/`(与 no-arbitrary-font-size 相同的 Literal/TemplateElement visitor)。可选二级检测:`(after|before):-inset` 未与 coarse 门控同串出现(抓 25 处裸扩区)。
2. **级别**:`warn`。全库 4079 处历史欠账,error 会瘫痪 CI;沿用 no-console/no-native-button 的「warn 存量、逐步清理」策略。
3. **白名单(files-based override,与现有 eslint.config.js 例外块同形态)**:
   - `src/components/ui/**`(primitive 与 DS 组件是机制本体,允许写 coarse);
   - 共享 util 定义处(建议新建 `src/components/ui/coarseHit.ts` 统一导出三档扩区常量,替代 8 份拷贝);
   - `src/styles/**`(CSS 不归 eslint 管,天然豁免);
   - 存量基线:首版可按目录豁免(debug-panel、translation、essay-grading 等已完成 COARSE_HIT 改造的模块),或 message 引导「新代码用 DsButton/共享常量」。
4. **message**:「coarse 触控目标请走 DsButton 默认尺寸 / @/components/ui/coarseHit 共享常量 / .touch-row,不要手写 [@media(pointer:coarse)] 任意变体(参见 AGENTS.md)」。
5. **前置依赖**:先落 §3.1 的 primitive 下沉 + 共享 coarseHit 出口,规则才有「正确写法」可指;顺序反了就是逼人绕路。

---

## 5. 第 3 轮替换优先级(体系化落地顺序,非散点清单)

1. **批 1:ComposerToolbar + 水位环/ContextUsagePopover(chat 输入条簇)**。理由:chat 是 -inset 扩区最重灾区(95 处),且 §2 的 P3 重叠(-inset-2×2 对 gap-2)与双重扩区都在这一簇;文件内已自带三档私有常量,是「私有常量 → 共享 coarseHit 出口」迁移的天然首站。动作:三档常量上收共享出口、水位环双层扩区并一层、右侧行改实体 min 尺寸或统一单层扩区。
2. **批 2:`buttonPrimitiveContract.ts` coarse min-h/min-w 下沉**(带契约测试更新)。一次覆盖 2165 个 DsButton 调用点,机制性消解 `!min-h-11` 散点的存在理由。
3. **批 3:lint 规则 `coarse-touch-target` 上线(warn + 白名单)**,冻结新增散点。
4. **批 4(可选,codemod 性质)**:批量删除下沉后冗余的 `[@media(pointer:coarse)]:!min-h-11`。明确**不**列 200 个手修点当任务——冗余覆盖与新机制同值,不删不伤功能。

---

## 6. 有意折衷清单(勿当新洞、勿派修)

来源:`docs/dev/mobile-uiux-unify/WRAP-UP.md` + ROUND-41~90 FIXES 固定段落。

1. **MiniCalendar / TabBar 宽 28**:有意折衷,勿硬叠 44 视觉(ROUND-47/67/78 等反复钉死)。
2. **FinderToolbar 视觉 40 + 伪元素扩到 48**:标题栏高度约束,勿再硬叠 44 视觉(`FinderToolbar.tsx:273` 注释与 ROUND 文档一致)。
3. **翻译 SourcePanel / ComparisonView 的 COARSE_HIT 凑 44**:已定型,勿重做视觉(可参与常量上收,但不改行为)。
4. WRAP-UP「不要再当新活」段其余项:热力图格子/内联 chip(QbankCitationBadge / MindmapCitationCard)/行内链接勿硬叠 44 视觉;侧栏/subagent 触控重叠、drawer-close 层叠等均为已知边界。
5. `.touch-row` coarse 抬 48px、桌面 44px 是既定基线(`responsive-utilities.css:158-168`),与 44 基线并存属设计而非不一致。
6. TabBar 重叠热区以 `z-[1]` 仲裁(`TabBar.tsx:239`)是有意设计,不算 §2 重叠风险。

---

## 附:红线自查

- 未建议开多路散点小修;所有散点仅记台账(§1/§2)。
- 产出为机制三件套评估:primitive 下沉(§3)+ 共享常量出口(§4.3/§5.1)+ lint 冻结(§4),替换按簇分 4 批(§5)。
