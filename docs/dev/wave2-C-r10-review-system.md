# 0824 Wave2-C · R10 组件体系 / lint 交叉终审

- 取证时间：2026-08-26（UTC）
- 分支 / HEAD：`cursor/0824-wave2-mobile-uiux-a875` / `fe8ff43c`
- 模型：按本轮路由使用 `gpt-5.6-sol-xhigh-fast`，未降级到 `high-fast`；Cloud run
  的 `originalModelName` 仍为 `null`，无法从运行内独立复核子档位后缀
- 范围：只审组件体系、lint 与 input-bar 产品源；未使用 computerUse，未改产品代码，
  未 commit

## 结论

**实现口径通过，终审门禁暂不全绿。**

- `buttonPrimitiveContract` 已把 coarse 最小高宽下沉并接入 `DsButton` / shad
  Button；没有用 `!h-11` 或散点 44px 顶回去。
- `TouchTarget` 是非 button 的实体盒出口；`coarseHit` 是五档、静态字面量、
  coarse 门控的伪元素逃生舱，职责边界成立。
- `ds-components/coarse-touch-target` 的实际生效级别是 input-bar `error`、
  全局 `warn`、体系层 `off`，没有把全库升成 `error`。
- input-bar 产品源中 `!min-h-11` / class 字符串里的 `after:-inset` 均为 0；
  全文 grep 的三处 `after:-inset` 全是解释性注释。
- 唯一当前红灯是 `TouchTarget.source.test.ts` 把源码注释也当渲染类扫描：
  实现注释合法提到 `after:-inset`，测试因此误红。不能据此判产品实现失败，
  但也不能宣称相关契约测试全绿。

## 1. button primitive coarse 下沉

grep：

```bash
git grep -nF '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]' \
  -- src/components/ui/buttonPrimitiveContract.ts
git grep -nF '[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]' \
  -- src/components/ui/buttonPrimitiveContract.ts
```

结果为 `min-h=10`、`min-w=6`：

- `buttonSizeClassNames` 五档都有 coarse `min-h`；其中 `icon` 另有 `min-w`。
- `buttonIconSizeClassNames` 五档同时有 coarse `min-h/min-w`。
- coarse 保底位于各档 `lg:h-*` / `lg:w-*` 紧凑尺寸之后，使用 token 和
  `min-*`，没有 important 高度覆盖。

消费链 grep：

```text
src/components/ui/DsButton.tsx:76
  iconOnly ? buttonIconSizeClassNames[resolvedSize] : ... buttonSizeClassNames[resolvedSize]
src/components/ui/shad/Button.tsx:25-28
  default/sm/lg/icon -> buttonSizeClassNames.*
```

因此不是“只定义未消费”的孤立 contract。

## 2. TouchTarget 与 coarseHit 逃生舱

`TouchTarget.tsx:29-30` 定义 coarse 条件下的
`min-h/min-w-[var(--touch-target-size)]`；`:36-39` 叠加
`inline-flex shrink-0 items-center justify-center`；`:57-60` 通过 Radix `Slot`
支持 `asChild`，默认渲染 `span`。渲染类中没有伪元素扩区，也没有硬编码 44px。

`coarseHit.ts:24-44` 集中导出五档：

| 视觉尺寸 | 出口 | 外扩 |
|---|---|---|
| 36px | `coarseHitClassFor36` | `-inset-1` |
| 32px | `coarseHitClassFor32` | `-inset-1.5` |
| 28px | `coarseHitClassFor28` | `-inset-2` |
| 24px | `coarseHitClassFor24` | `-inset-2.5` |
| 16px badge | `coarseHitClassForBadge16` | `-inset-3.5` |

五档都是完整静态字面量，`after:absolute`、`after:-inset-*` 和
`after:content-['']` 均挂在 `pointer:coarse` 下。文件头明确记录实体盒优先、
硬布局才走逃生舱，以及相邻扩区的 stacking/抢点风险；没有新增第四种机制。

## 3. lint 严重级

配置 grep：

```text
eslint.config.js:123  'ds-components/coarse-touch-target': 'warn'
eslint.config.js:163  files: ['src/components/ui/**/*.{ts,tsx}']
eslint.config.js:166  'ds-components/coarse-touch-target': 'off'
eslint.config.js:175  files: ['src/features/chat/components/input-bar/**/*.{js,jsx,ts,tsx}']
eslint.config.js:177  'ds-components/coarse-touch-target': 'error'
```

`eslint --print-config` 的最终解析值：

```text
input-bar/ComposerToolbar.tsx -> [2]
features/settings/Settings.tsx -> [1]
components/ui/TouchTarget.tsx -> [0]
```

stdin 注入探针也验证了实际行为：

- input-bar 下的 `[@media(pointer:coarse)]:!min-h-11`：退出码 1，
  `1 error / 0 warnings`；
- input-bar 下的 `after:-inset-2`：退出码 1，`1 error / 0 warnings`；
- settings 下同一 `!min-h-11`：退出码 0，`0 errors / 1 warning`。

所以 input-bar 放量确实是 error，同时全局仍保持 warn；没有全库升 error。

## 4. input-bar 产品源散点

排除 `__tests__` / `*.test.*` / `*.spec.*` 后执行：

```bash
git grep -nE '!min-h-11|after:-inset' \
  -- src/features/chat/components/input-bar \
  ':(exclude)src/features/chat/components/input-bar/**/__tests__/**' \
  ':(exclude)src/features/chat/components/input-bar/**/*.test.*' \
  ':(exclude)src/features/chat/components/input-bar/**/*.spec.*'
```

只返回：

```text
ComposerToolbar.tsx:53    // after:-inset ...互相重叠
ComposerToolbar.tsx:208   JSX 注释：避免双重重叠
ContextUsagePopover.tsx:90 JSX 注释：不再用透明 after:-inset
```

进一步 grep 引号/模板字面量中的目标串为 **0 命中**；`npx eslint --quiet
'src/features/chat/components/input-bar/**/*.{js,jsx,ts,tsx}'` 退出码 0。结论：
当前 input-bar 产品源没有 `!min-h-11`，也没有内联 `after:-inset` 类；三处全文
命中均属任务明确排除的注释。

input-bar 中确需保持小视觉尺寸的消费点已引用共享 `coarseHitClassFor24/28/
Badge16`，没有把逃生舱字面量复制回调用点。

## 5. 定向测试与阻断项

| 命令 | 当前结果 | 判定 |
|---|---:|---|
| `vitest`：button primitive + TouchTarget source contracts | 1 file passed / 1 failed；10 passed / 1 failed | **红** |
| `vitest`：`coarseTouchTargetRule.test.ts`（当前工作树） | 34/34 passed | 绿 |
| input-bar ESLint `--quiet` | exit 0 | 绿 |

红灯根因精确在 `TouchTarget.source.test.ts:37`：

```ts
expect(touchTargetSource).not.toMatch(/(?:after|before):-inset/u);
```

它扫描整份源码，而 `TouchTarget.tsx:16` 的设计注释合法说明“不是伪元素
`after:-inset` 扩区”。这是注释误伤，不是渲染类残留。后续应让测试只提取字符串
字面量（input-bar R7 契约已有同类做法），不要为消红删除设计注释，也不要修改
产品组件或手贴 44px。

另：本次取证开始时，HEAD 上的 lint RuleTester 因 ESLint flat config
`No matching configuration found` 为 2 passed / 32 failed；取证期间出现了非本审
产生的未提交测试修正（配置 `files` 并调整 `Linter` cwd），当前工作树复跑已
34/34 通过。最终提交若遗漏该测试修正，HEAD 仍会回到原红灯。

## 最终裁决

- **组件体系 / 实际 lint / input-bar 产品源：PASS。**
- **相关契约测试全绿：FAIL（1 个注释误伤；HEAD 还需保留当前未提交的 RuleTester
  修正）。**
- 本审只新增本报告；没有全库升 error，没有手贴散点 44px，没有 commit。
