# 0824 Wave2-D R5：持久化状态集中版本迁移框架 设计稿

> 定位：**设计稿**。本轮（R5）不改产品代码、不编译、不 commit；本文冻结
> "范围边界 + 目标形态 + 迁移函数契约 + 落地节奏"，供后续轮次实施。
> 事实基线：仓库 tip `bfbe1951`（分支 `cursor/0824-wave2-cloud-data-a875`）。
> 关联文档：
> - `docs/dev/wave2-D-config-state-machine.md`（R2 云配置三态状态机；其
>   generation 不变量与"唯一发布点"约束是本文 §5.5 的前提）；
> - `docs/dev/wave2-D-declarative-repair-steps.md`（R5 同批设计稿；SQL schema
>   修复归它，本文只管 KV/JSON 持久化状态，边界见 §2）。

---

## 1. 一句话问题陈述

本仓库的**非 SQL 持久化状态**（前端 zustand persist、散落 localStorage 键、
后端 settings 库 KV、secure_store 记录、带版本信封的交接 payload）各自发明了
自己的版本化与迁移方式——有的有版本号有迁移函数，有的用键名后缀当版本，有的
完全裸写。没有集中注册表，没有统一的损坏处置策略，没有降级（新数据被旧版
App 读到）语义。每次改 persisted 形状都是一次临场发挥。

对照面：SQL schema 侧早已有一整套纪律——refinery 显式版本迁移 + coordinator
修复链 + `STARTUP_COMPAT_REPLAY_MAX_VERSION = 20260801` 冻结边界 + checksum
fail-close（见 R1 报告 06-coordinator.md §6）。KV/JSON 侧配得上同等纪律。

---

## 2. 范围与边界

**归本框架管**：

- 前端 zustand `persist` 中间件的持久化分片（localStorage 承载）；
- 前端各 feature 直接 `localStorage.getItem/setItem` 的散键；
- 后端 settings 库的 KV 键（JSON payload，如云配置 SSOT）；
- 跨层传递、落地存储的**版本信封 payload**（如题库练习交接件）；
- secure_store 里凭据记录的 **schema 形状**（字段增减）——注意与 R2 的
  generation 区分，见 §5.5。

**明确不归本框架管**：

- SQLite 表结构与数据迁移——refinery + coordinator 的领地（声明式 repair
  step 设计见姊妹文档），本框架不碰任何 `CREATE/ALTER TABLE`；
- R2 状态机的 generation（`N → N+1`）——那是**并发原子性代数**（哪一整套
  配置+凭据是 active），不是 schema 版本。同一 generation 下 payload 可以有
  schema version，两轴正交（§5.5）；
- 进程内非持久化状态（普通 zustand store、React state）。

---

## 3. 现状盘点（tip `bfbe1951` 实测）

同一仓库里并存**五种**版本化/迁移形态：

### 3.1 形态 A：zustand persist + 版本号 + 手写 migrate（最佳现状）

- `dstu-auto-sync`（`src/stores/syncStatusStore.ts`）：`version: 2`（:464），
  迁移函数 `migrateAutoSyncPersisted`（:361-382）——total 函数，任意输入
  （含非对象）都归一为合法 `AutoSyncPersisted`，逐字段校验回退默认值；
  `migrate` 与 `merge` 双挂（:472-476）。**亮点**：自定义
  `createAutoSyncPersistStorage`（:390-438）在 storage 边界处理损坏 payload
  ——`JSON.parse` 失败或缺 `state` 信封即弃（removeItem）返回 null，防止
  "坏 payload 导致 hasHydrated 永远 false、每次启动重复失败"。文档注释
  （:384-389）明确了这个动机。
- `dstu-ui-store`（`src/stores/uiStore.ts`）：`version: 1`（:52），
  `migratePersistedUIState`（:20），有专门的迁移测试
  （`__tests__/uiStore.sidebarWidth.test.ts`：v0 legacy 272px 默认宽度迁移，
  自定义宽度不动）。**但没有** storage 边界的损坏处置——损坏 payload 的
  行为与 auto-sync 不一致。

### 3.2 形态 B：zustand persist / 直写 localStorage，无版本无迁移

全仓 20+ 文件直接 `localStorage.getItem/setItem`（`src/App.tsx`、
`src/features/workbench/` 多个组件、`src/hooks/useSystemSettings.ts`、
`useQuestionBankSession.ts`、`useAppUpdater.ts`、
`src/features/settings/components/CloudStorageSection.tsx` 的表单草稿缓存等）。
键名散落、无版本号、读取方各自 try/catch 或裸用。形状一变，旧值要么被
JSON.parse 炸掉、要么以错误形状静默流入运行时。

### 3.3 形态 C：版本信封 payload

`QbankPracticeHandoff`（`src/stores/questionBankStore.ts:497-509`）：
`{ version: 1, kind: 'qbank_practice_session', ... }`——显式版本 + kind 判别
的信封，构造侧对 session 全字段 fail-closed 校验（:620-736）。这是**信封
模式的正确样板**，但版本号语义（读到 `version: 2` 怎么办）没有集中定义。

### 3.4 形态 D：键名后缀当版本（后端 settings KV）

`CLOUD_CONFIG_SSOT_SETTING_KEY = "cloud_storage.config.safe_v1"`
（`src-tauri/src/cloud_config_commands.rs:14`）。版本编码在**键名**里：升版
= 换键。优点是新旧互不污染、天然 fail-closed（旧 App 读不到新键）；缺点是
旧键成为无人认领的遗留物（谁负责读旧写新？谁负责删旧键？目前无答案），且
"当前最新版是哪个键"只存在于常量命名约定里。

### 3.5 形态 E：secure_store 记录（+ R2 分代元数据）

`cloud_storage_credentials` 单键记录；R2 状态机在其上叠加 staged 记录与
active generation 元数据（wave2-D-config-state-machine.md §5.1）。凭据记录
自身的字段形状目前无版本号——增减字段靠读取侧宽容解析。

### 3.6 病灶汇总

1. **无集中注册表**：哪些键是持久化状态、各自版本几、迁移链在哪，没有单一
   事实来源；改形状靠 grep。
2. **损坏处置不一致**：auto-sync 有 storage 边界弃置，ui-store 没有，散键
   全靠运气。
3. **无降级语义**：新版本 App 写下 v3 payload，用户回退旧版 App（读 v2 的
   代码）读到 v3——目前所有形态都没定义这一幕，多数会以错误形状静默运行。
4. **键名后缀版本无收编流程**：`safe_v1` 若升 `safe_v2`，旧键遗留与双读
   顺序无既定规则。
5. **迁移函数无统一契约**：total 还是 partial、能不能抛异常、要不要 fixture
   测试——各写各的。

---

## 4. 设计原则

继承 SQL 侧与 R2 状态机已验证的方法论，翻译到 KV/JSON 世界：

- **P1 显式版本、显式迁移**（对应 coordinator 的"冻结边界后必须显式处理"）：
  每个持久化命名空间必有整数版本号与逐级迁移链；不做"自动 schema 推断"。
- **P2 fail-closed 优先**（对应 checksum fail-close 与 R2 失败矩阵）：读不懂
  就按命名空间既定策略弃置或拒绝，绝不以错误形状继续运行。
- **P3 total 迁移函数**：迁移/清洗函数对任意输入产出合法输出或显式判损，
  不抛异常——`migrateAutoSyncPersisted` 是现成样板。
- **P4 不静默重置用户数据**：弃置（reset 到默认）只允许发生在两种情形——
  payload 判损，或命名空间显式声明"可弃置"（UI 偏好类）。配置类、学习数据
  类命名空间禁止以 reset 作为迁移失败的兜底。
- **P5 版本轴与 generation 轴正交**：schema version 描述"payload 长什么样"，
  generation 描述"哪一整套是 active"；迁移不得成为绕过 R2 唯一发布点
  （不变量 I1）的后门（§5.5）。

---

## 5. 框架设计

### 5.1 统一概念模型

每个持久化状态单元登记为一个**命名空间（namespace）**：

```ts
interface PersistedNamespace<T> {
  /** 存储键名（zustand persist name / localStorage key / settings 键）。 */
  key: string;
  /** 存储层：'zustand' | 'localStorage' | 'settings-kv' | 'secure-store'。 */
  layer: PersistedLayer;
  /** 当前 schema 版本（正整数，只增不减）。 */
  currentVersion: number;
  /** 逐级迁移链：migrations[v] 把 v 版 payload 迁到 v+1 版。 */
  migrations: Record<number, (input: unknown) => unknown>;
  /** total 清洗函数：迁移链走完后的最终校验/归一（P3）。 */
  sanitize: (input: unknown) => T | typeof CORRUPT;
  /** 判损与降级时的处置策略（见 5.4）。 */
  onCorrupt: 'discard-to-default' | 'fail-closed';
  onNewerVersion: 'discard-to-default' | 'fail-closed';
}
```

读取流水线固定为：

```
原始字符串 → JSON.parse（失败→onCorrupt）
           → 信封校验 { version, state }（缺失→onCorrupt）
           → version > currentVersion？（→onNewerVersion，见 5.4）
           → 逐级跑 migrations[version..currentVersion-1]
           → sanitize（CORRUPT→onCorrupt）
           → 合法 T
```

写入流水线固定为：总是写 `{ version: currentVersion, state }` 信封。

### 5.2 前端集中注册表

- 新增 `src/stores/persistedStateRegistry.ts`（命名可调）：全部前端命名空间
  在此登记；zustand persist 的 `version` / `migrate` / `merge` / `storage`
  参数一律从注册表条目**派生**，store 文件不再手写这四件套。
- 通用 storage wrapper：把 `createAutoSyncPersistStorage` 的损坏弃置模式
  （syncStatusStore.ts:390-438）提炼为 `createValidatedPersistStorage(ns)`，
  所有 zustand 命名空间共用——ui-store 的损坏处置不一致（§3.1）由此收敛。
- 散键（形态 B）收编：提供 `readPersisted(ns)` / `writePersisted(ns)` 两个
  薄封装，逐键迁入注册表。**收编不要求一次完成**（节奏见 §7），但立规矩：
  新增持久化键必须走注册表，lint/评审把关（可配 ESLint 规则禁裸
  `localStorage.setItem`，白名单豁免存量，逐步清空白名单——仓库已有自定义
  规则目录 `eslint-rules/` 可承载）。
- 版本信封 payload（形态 C，如 `QbankPracticeHandoff`）：不强改现有结构
  （它已是正确形态），只把"读到更高版本怎么办"登记进注册表策略字段。

### 5.3 后端 settings KV 的版本化

后端选**信封方案**为主、键名后缀为例外：

- 常规命名空间：settings 值统一为 `{ "v": <schema_version>, "state": ... }`
  信封；后端维护对应的集中注册表（`src-tauri` 内一个 module，形态同 5.1，
  Rust 类型）。读取流水线同 5.1。
- 键名后缀版本（形态 D，`safe_v1`）作为**遗留形态保留登记**：注册表条目
  允许声明 `legacyKeys: ["cloud_storage.config.safe_v1"]` 与收编规则——
  **读旧写新，写新成功后删旧**；双键并存期间新键优先。是否把 `safe_v1`
  真的升版收编是独立产品决策，本框架只保证"下一次升版时有既定流程可走"，
  不在本文强制升版。
- secure_store 凭据记录（形态 E）：给记录体加 `schema_version` 字段（缺省
  视为 1，兼容存量），迁移在解密后的结构化层做，同一套读取流水线。

### 5.4 降级与前向兼容（onNewerVersion）

"新 App 写 v3 → 用户回退旧 App（只认 v2）"是现状完全未定义的一幕。策略按
命名空间敏感度二分：

| 类别 | 策略 | 例子 |
| --- | --- | --- |
| UI 偏好 / 可再生缓存 | `discard-to-default`：弃置并按当前版本重写默认值。丢的只是偏好，换来可用。 | `dstu-ui-store`、表单草稿缓存、工作台壁纸/布局 |
| 配置 / 凭据 / 学习数据指针 | `fail-closed`：**原样保留不覆盖**，该功能报"配置由更新版本写入，请升级应用"（稳定错误码，如 `E_PERSISTED_STATE_FROM_NEWER_VERSION`）。绝不弃置、绝不猜读。 | 云配置 SSOT、凭据记录、auto-sync 开关、练习交接件 |

注意 `discard-to-default` 在降级场景意味着**旧 App 会用 v2 信封覆盖 v3
payload**，用户再升级回新 App 时 v2→v3 迁移会再跑一遍——因此凡是登记为
discard 的命名空间，其迁移链必须可重入（migrations 幂等于已迁移形状之上，
由 sanitize 兜底保证）。

### 5.5 与 R2 generation 不变量的兼容（硬约束）

R2 状态机冻结了三条不变量（wave2-D-config-state-machine.md §2），其中：

> **I1（唯一发布点）**：active SSOT 与 active 凭据只允许被
> `cloud_config_publish` 和 clear 流程写入/删除。

这对本框架意味着：

- 云配置 SSOT / 凭据这两个命名空间的**读时迁移不得写回**。迁移在读取路径
  的内存中完成（读 v1 信封 → 内存迁到 v2 形状 → 交给消费者）；持久化层的
  升版**只能搭 publish 的车**——下一次 `cloud_config_publish` 落盘时自然以
  `currentVersion` 信封写入，走完整的 snapshot → staged → commit 事务与
  失败矩阵。框架为此提供 `writeBackPolicy: 'never' | 'on-read' | 'via-owner'`
  字段，这两个命名空间钉死 `via-owner`。
- 其余命名空间缺省 `on-read`（读到旧版即迁移并回写新信封），这是 zustand
  persist 的天然行为，保持不变。
- generation 与 schema version 互不解释：commit 使 generation `N → N+1`，
  payload 的 `v` 不因此变化；反之升 `v` 也不 bump generation。测试须包含
  "publish 升代但 schema version 不变""读时迁移不改 generation"两条断言。

---

## 6. 迁移函数契约

每条 `migrations[v]` 与 `sanitize` 必须满足：

1. **total**：任意 `unknown` 输入不抛异常；无法理解的输入由 sanitize 判
   `CORRUPT`，交给 `onCorrupt` 策略。样板：`migrateAutoSyncPersisted`
   （syncStatusStore.ts:361-382，逐字段校验回退默认）。
2. **纯函数**：不读时钟、不读其他 store、不发 IPC。跨命名空间联动迁移
   （极少数）显式建模为启动期一次性任务，不塞进迁移链。
3. **逐级链式**：v1→v3 必须经 v1→v2→v3，禁止跨级捷径——保证任意历史版本
   的存量都走同一条路径，测试矩阵线性而非平方。
4. **fixture 测试**：每级迁移至少一条"真实历史 payload → 期望输出"的
   fixture 测试（样板：`uiStore.sidebarWidth.test.ts` 的 v0 legacy 272px
   用例）；损坏输入与更高版本输入各至少一条策略测试。
5. **可重入**（仅 discard 类命名空间需要，§5.4）：对已是目标形状的输入，
   迁移+sanitize 结果幂等。

注册表本身配结构性测试（呼应姊妹文档 §8 的做法）：

- 枚举断言：每个命名空间 `currentVersion >= 1`；`migrations` 恰好覆盖
  `1..currentVersion-1` 每一级、无空洞无越界；
- 策略断言：`onNewerVersion == 'discard-to-default'` 的命名空间集合是显式
  白名单（配置/凭据类禁止出现在其中）；`writeBackPolicy == 'via-owner'` 的
  集合精确等于 {云配置 SSOT, 云凭据}；
- 键名唯一性：全注册表 key 无重复，且 legacyKeys 与主键集合无交集。

---

## 7. 落地节奏（按阶段，不估日历时间；每阶段独立可合）

- **阶段 A（前端注册表 + 存量三空间收编）**：建注册表与
  `createValidatedPersistStorage`；`dstu-auto-sync`、`dstu-ui-store` 平移
  接入（行为零变化，既有迁移测试原样通过；ui-store 顺带获得损坏弃置）；
  `QbankPracticeHandoff` 登记策略字段。产出结构性测试。
- **阶段 B（散键收编 + lint 闸门）**：ESLint 禁裸 `localStorage` 写入
  （存量白名单豁免）；按 feature 分批把散键迁入注册表，优先迁"形状最近
  变过/最可能再变"的键（云配置表单草稿、workbench 布局）。
- **阶段 C（后端注册表）**：settings KV 信封与 Rust 注册表；
  `cloud_storage.config.safe_v1` 登记为 legacy 键并落"读旧写新删旧"规则
  （实际升版另行决策）；secure_store 记录体加 `schema_version`（缺省 1），
  与 R2 分代 API 的实施顺序解耦——若分代 API 先落地，字段以加法追加。
- **阶段 D（降级策略全量生效）**：`onNewerVersion` 策略在所有已收编命名
  空间启用，补齐 `E_PERSISTED_STATE_FROM_NEWER_VERSION` 的 UI 呈现文案。

---

## 8. 验收清单（实施完成后按此核对）

- [ ] 注册表存在，且 `dstu-auto-sync` / `dstu-ui-store` 的
      version/migrate/merge/storage 全部派生自注册表，行为测试零改动通过；
- [ ] 损坏 payload 在所有已收编命名空间的行为一致（storage 边界弃置或
      fail-closed，按登记策略），有测试；
- [ ] 读到更高版本 payload：UI 偏好类弃置重建、配置/凭据类 fail-closed 报
      稳定错误码，有测试；
- [ ] 云配置 SSOT / 凭据命名空间 `writeBackPolicy = via-owner`：读时迁移
      零持久化写入（红灯测试：读旧版 SSOT 后，settings 键字节不变）；
      持久化升版仅发生在 publish 事务内；
- [ ] generation 与 schema version 正交的两条断言测试在（§5.5）；
- [ ] 结构性测试全绿（迁移链无空洞、策略白名单、键名唯一）；
- [ ] ESLint 裸 `localStorage` 写入闸门生效，白名单只减不增。

---

## 9. 开放问题（实施前需决策，本文不冻结）

1. 前端注册表与后端注册表是否共享一份键名/版本清单（生成式同步）还是各自
   维护 + 一致性测试——倾向后者起步，避免过早引入代码生成。
2. `safe_v1` 是否真的升版收编（§5.3 只保证流程存在）；若升版，是否借道
   R2 publish 的某次既定改动一并做。
3. 散键白名单的清空是否设硬指标（如阶段 B 结束白名单 ≤ N 条）。
4. secure_store 记录 `schema_version` 放加密信封内还是外——信封内更防
   篡改，信封外可不解密判版；倾向信封内，判损即走 onCorrupt=fail-closed。

---

## 附：本文红线自查

- 只写文档到 `/workspace/docs/dev/`；未改任何产品代码 / 配置 / fixture。
- 未编译、未测试、未 commit、未 push。
- 未触碰 R2 状态机已冻结语义（I1/I2/I3、失败矩阵、口令准入）；本文所有与
  云配置相关的设计均以"兼容并服从 R2 不变量"为前提（§5.5）。
