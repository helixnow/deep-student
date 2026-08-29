# 0824 Wave2-C 第 3 轮：coarse-touch-target 规则审阅（09-lint-review）

审阅对象：`eslint-rules/coarse-touch-target.js` + `coarse-touch-target.allowlist.json` + `eslint.config.js` 接线 + `tests/vitest/coarseTouchTargetRule.test.ts`（03-lint.md 产出）。
方法：未跑 eslint/vitest（本轮禁令）。用 `rg --pcre2` 以规则同款正则全仓扫描估算命中面，用 node 单脚本对边界样本逐条核对三条正则判定，用 node 校验 allowlist JSON 可解析、规则模块可加载。

## 结论

规则语义正确，**正则零修改**；`warn` 级别保持不变；`eslint.config.js` 无需改动。
实际修的是白名单边界（摘除 2 条过期/僵尸条目）与规则文案里指向已不存在符号的引用，测试同步更新。

## 一、误报复核（重点核对项，全部通过）

用 node 对三条正则（`COARSE_MIN_OVERRIDE` / `BARE_IMPORTANT_44` / `BARE_HIT_INSET`）核对：

| 样本 | 判定 | 说明 |
| --- | --- | --- |
| `min-h-[var(--touch-target-size)]`（裸 token） | 放过 ✅ | 任务点名项；三条正则都不含 var 备选 |
| `[@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]`（important+token） | 放过 ✅ | 存量实例：MobileBreadcrumb、UnifiedSidebar btnPadding、shad Input/Select |
| DsButton contract 新后缀 `[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`（buttonPrimitiveContract.ts 各 size，含 icon 的 min-w 双后缀） | 放过 ✅ | 无 `!` 且值为 token，两条 min 正则均不命中 |
| nav variant 的裸 `min-h-[2.75rem]`（无 important） | 放过 ✅ | `BARE_IMPORTANT_44` 要求 `!`，contract 内该形无 `!` |
| `!min-h-[44px]` / `!min-w-[2.75rem]`（裸 important 常量） | 拦 ✅ | 写死触控常量，真阳性 |
| `lg:!min-h-[44px]`（变体前缀） | 放过 | lookbehind 排 `:`，03-lint.md 已登记的有意收窄 |
| `!h-110` / `!h-11.5` / `after:-inset-px` / 正值 `after:inset-x-0` | 放过 ✅ | 负先行 / px 描边 / 正值边界都对 |
| coarseHit.ts 各档 `after:-inset-*` 导出串 | 命中 bareHitInset（但该文件在 ui/** 目录级 off 内，实际不报）✅ |

contract 侧交叉核对：`buttonPrimitiveContract.ts` 本轮 coarse 保底后缀全部是**非 important 的 token 形**（`[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]`，icon 追加 min-w），即使该文件不在 ui/** 免检目录也不会被拦。业务组件抄用 contract 后缀不会触发误报。

`bareHitInset` 潜在误报面（装饰性负 inset，如发光圈）抽样核对：排除 ui/**、测试、白名单后的业务命中全部是 `content-[''] + absolute + -inset` 命中区扩区形（多数带 coarse 前缀），未发现装饰性用法被误伤。

## 二、白名单边界修正（本次改动核心）

摘除 2 条，剩 7 条（TabBar、FinderToolbar、翻译四件套、essay-grading InputPanel），逐条用规则正则复扫确认**仍有真实命中且与登记理由一致**（TabBar 3 行、FinderToolbar 9 行、TranslationMain 2 / SourcePanel 3 / TargetPanel 4 / ComparisonView 1 / InputPanel 8）。

### 摘除 1：ComposerToolbar.tsx（任务指令项）

本轮右簇已改实体盒（`coarseSolidTouchTargetClass`，token 形 min-h/min-w），`coarseHitAreaClass / coarseHitAreaLgClass` 与 after:-inset 实现已删——原登记理由（「伪元素扩区范式定义处」）失效。摘除后该文件回到正常拦截面，会新增 **3 行 coarseMinOverride warn**（L69 发送钮 `[@media(pointer:coarse)]:!h-11 !w-11`、L734 搜索输入 `!h-11`、L879 变体发送钮 `!w-11 !h-11`）：这是真实的硬编码散点，按存量 warn 记账，后续迁 token 形清理，不作折衷。

### 摘除 2：MiniCalendar.tsx（僵尸条目）

全文以规则正则复扫 **0 命中**——其折衷（coarse 下 h-9/w-9，非 important、非 44 级）本来就不在拦截面内。条目留着是整文件盲区：将来该文件新增 `!min-h-11` 散点会被静默豁免。摘除零新增 warn，纯收紧边界。折衷本身仍由 ROUND-81/90 文档背书，与 lint 白名单无关。

未新增任何条目（未把半个库加进白名单）。伪元素扩区的正统出口已由本轮 `src/components/ui/coarseHit.ts`（ui/** 目录级 off）承担，业务侧直接 import 常量即不含字面量、天然不触发；仍内联字面量的存量（settings/McpToolsSection、QuestionBank 系列等）保持 warn 记账。

## 三、规则文案修正（小改，不动正则/级别）

`bareHitInset` 报错文案与文件头注释原指向 `InputBarUI coarseHitAreaClass`——该符号在实体代码中已不存在（仅剩翻译面板注释顺带提及），新人照文案找不到范式。改为指向本轮共享出口 `@/components/ui/coarseHit` 的 `coarseHitClassFor36/32/28/24/Badge16`，并注明「仅硬布局约束撑不出实体盒时使用」（与 coarseHit.ts 的逃生舱定位一致）。头注释里白名单举例同步把 MiniCalendar 换成 TabBar。

`eslint.config.js`：`'ds-components/coarse-touch-target': 'warn'` 保持不变（任务要求，且 ~1900 行存量未清，升 error 会阻塞 CI）；ui/** 目录级 off 恰好覆盖新建的 coarseHit.ts；测试目录 off 覆盖 ComposerToolbar.hitTarget.source.test.ts 等把类名当断言样本的源测试。无需改动。

## 四、测试同步（只写未跑）

`tests/vitest/coarseTouchTargetRule.test.ts`：

1. 放行用例组新增 3 条：DsButton contract size 后缀全串、icon 的 min-h+min-w 双后缀串、nav 的裸 `min-h-[2.75rem]`；
2. 白名单用例把 MiniCalendar 换成 TabBar（仍在名单内的真实条目）；
3. 新增反向用例 `no longer allowlists`：ComposerToolbar 与 MiniCalendar 路径下同样代码必须报 1 条；
4. 文案断言从 `coarseHitAreaClass` 改为 `@/components/ui/coarseHit` + `coarseHitClassFor`。

## 五、遗留（不在本轮边界）

- 非 `!` 的 `[@media(pointer:coarse)]:min-h-11` 仍放行（03-lint.md 登记的有意收窄），第 8 轮放量时再议；
- ComposerToolbar 新暴露的 3 行 `!h-11/!w-11` 散点，随批 1 调用点迁移一并改 token 形（`!h-[var(--touch-target-size)]` 或实体盒常量）；
- 白名单 7 条中翻译 COARSE_HIT 族与 InputPanel 可在调用点迁到 coarseHit.ts 共享出口后摘除（届时文件内不再有字面量，条目自然可删）。
