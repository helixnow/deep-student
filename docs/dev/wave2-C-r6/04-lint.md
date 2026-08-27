# 0824 Wave2-C 第 6 轮复核 · 04-lint（coarse-touch-target 规则 + allowlist）

- 席位：R6 复核员-lint（只读复核；未跑 eslint，按任务约束）
- 对象：`eslint-rules/coarse-touch-target.js`、`eslint-rules/coarse-touch-target.allowlist.json`、`eslint.config.js` 注册段
- 工作树：/tmp/0824-wave2-c-r6-lint @ b35038a8（干净）；交叉核对 /tmp/0824-wave2-c-r6-touch 的 F3 改动

## 结论（TL;DR）

**PASS，零改动。** allowlist 不需要改：FinderQuickLook 从未登记入白名单，F3 改走体系（`coarseHitClassFor36` 共享出口）后文件源码零命中，自然无需登记也无需移出。规则保持 `warn`（eslint.config.js:122），未动。白名单 7 条经逐条比对均仍有效命中，无 stale 条目。

## 一、F3 × allowlist 核查（本席位核心问题）

任务前提是「若 F3 改走体系后 FinderQuickLook 需移出白名单则改 allowlist」。实况：

1. **FinderQuickLook 本就不在白名单。** 现行 allowlist 共 7 条：TabBar、FinderToolbar、TranslationMain、SourcePanel、TargetPanel、ComparisonView、essay-grading/InputPanel。`git log --follow` 显示该 JSON 仅一次提交（752b592c，R3），从未含 FinderQuickLook。
2. **F3 定义**（wave2-C-ledger.md:81 / R5 卡 5）：FinderQuickLook 补 `registerBackHandler` overlay 档注册 + 关闭钮按伪元素范式对齐 44（非散贴）。
3. **F3 修法已确认改走体系**：r6-touch 工作树的未提交 diff 把关闭钮内联的
   `[@media(pointer:coarse)]:after:absolute … after:-inset-1 … after:content-['']`
   整段替换为 import `coarseHitClassFor36`（`src/components/ui/coarseHit.ts:24`，-inset-1 档），返回键注册（FinderQuickLook.tsx:102）已在。
4. **改后零命中（正则采样验证，非跑 eslint）**：
   - 剩余字面量 `!h-6 !w-6 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10` —— COARSE_MIN_OVERRIDE 只认 11/[44px]/[2.75rem] 档，`!h-10` 不中（40px 视觉是标题栏防撑高的有意取值，非 44 散贴）；
   - 「打开」钮 `[@media(pointer:coarse)]:min-h-11`（无 `!`）—— 规则按设计只拦 `!` 强制形，不中；
   - `coarseHitClassFor36` 是标识符引用，规则只扫当前文件字符串字面量，其定义处 `src/components/ui/**` 在 eslint.config.js:165 整目录关闭（体系本体）。

**判定：无需改 allowlist（「仅当必须才改」→ 不必须）。** 若 F3 当初改成在 FinderQuickLook 里继续散贴内联 after:-inset 才需要登记；现在走共享出口是最优解，白名单保持 7 条。

## 二、规则本体复核（coarse-touch-target.js）

三条正则用 node 采样自检（9 组用例），行为与文档注释一致：

| 用例 | 期望 | 实测 |
|---|---|---|
| F3 改前关闭钮（内联 after:-inset-1） | bareHitInset 中 | ✅ 中 |
| F3 改后关闭钮（!h-10 + 共享出口） | 全不中 | ✅ |
| `[@media(pointer:coarse)]:!min-h-11` | coarseMinOverride 中 | ✅ |
| token 形 `!min-h-[var(--touch-target-size)]` | 放过 | ✅ |
| `!h-110`（防误吞） | 放过 | ✅ |
| 裸 `!min-h-[44px]` | BARE_IMPORTANT_44 中 | ✅ |
| `after:-inset-px`（装饰描边） | 放过 | ✅ |
| 正值 `after:inset-x-0` | 放过 | ✅ |

其余实现点均健康：allowlist 读取（module load 一次 readFileSync + posix 归一 + 后缀匹配）、`context.filename ?? context.getFilename?.()` 兼容 ESLint 8/9、Literal + TemplateElement 双入口、BARE_IMPORTANT_44 的 lookbehind 排 `:` 避免与 coarse 形重复上报。

低优先观察（不改，供第 8 轮升 error 时参考）：
- 非 `!` 形 `[@media(pointer:coarse)]:min-h-11` 按设计不拦（FinderQuickLook:273 即一例，DsButton size="sm" 体系已内建 coarse 44，该类可能冗余但无害）；升 error 前可评估是否扩拦。
- 每个字面量 coarseMinOverride 只报首个匹配（`??` 短路），warn 粒度下可接受。
- allowlist 后缀匹配 `endsWith('/'+path)` 理论上可被同名后缀路径误豁免，本仓库无此风险。

## 三、allowlist 逐条有效性（无 stale）

全库 rg（与规则同款 pcre2 正则）命中约 370 文件——与「存量散点较多，先 warn，第 8 轮清完升 error」的既定节奏一致，白名单只登记「有意折衷勿重做」7 文件而非全部存量,定位正确。7 条登记文件全部仍在命中列表中（TabBar / FinderToolbar / 翻译四件 / essay-grading InputPanel），无一条可移除。

## 四、eslint.config.js 注册段

- `ds-components/coarse-touch-target: 'warn'`（:122）——保持 warn，符合任务约束，未动；
- `src/components/ui/**` off（:165，体系本体）、tests off（:215，契约样本引用）——门控合理。

## 五、改动清单

无。未改任何文件，未 commit（按任务约束）。

## 六、给同轮席位的备注

- touch 席位（F3）：`coarseHitClassFor36` 档名按「36px 视觉→44」设计,此处用在 40px 视觉钮上（40+2×4=48≥44），功能达标且与 FinderToolbar 先例同款 -inset-1，仅档名语义略错位，注释里已写明,可不动。
- 若后续轮次有人把 FinderQuickLook 改回内联散贴,规则会以 bareHitInset warn 拦住,无需白名单兜底。
