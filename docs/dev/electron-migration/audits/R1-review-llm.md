# R1-review-llm：B 级独立交叉审读

## 集成兼容归档（2026-11-05，C1 08:59Z优先级）

按C1本轮明确授权，将三个超出allowlist的R1自有验收文件完整归档于本文末尾，然后撤回原路径的R1新增文件。固定搬迁前review为 `352e712376661b0e15df76f918653389a791c55a`，已merge正常main `915b4b9936beb12aa7946ee3fb8fa68b4a6f023b`。`git ls-tree main -- <三个路径>`为空；`git diff --name-status main HEAD`三者均为A；逐文件全部提交历史均为下表列出的R1审计提交，未发现main内容或他人增量。只撤回这三个新增文件，不覆盖任何实现、测试或他人文档。

| 原路径 | 创建提交 | 后继R1更新（按时间） | 搬迁前Git blob | 本文完整原文 |
|---|---|---|---|---|
| `host/plugins/integration/ACCEPTANCE.md` | `bf6479dc83bc52bd8970e018e58308e8c5c4aff3` | `8044194982b918f03bc24ea332725b4fb4310164` → `786d4cbc20914d54eb2ce5b1148053bf0b02ee6e` | `0b0d495391e2ebdaa71b4bbc2c1a234683ca5eee` | [integration归档](#r1-integration-acceptance) |
| `host/plugins/media/ACCEPTANCE.md` | `bf6479dc83bc52bd8970e018e58308e8c5c4aff3` | `8044194982b918f03bc24ea332725b4fb4310164` | `4ed3bf3d0f6b1180d7a4e8487c0027e082b30b98` | [media归档](#r1-media-acceptance) |
| `host/plugins/translation/ACCEPTANCE.md` | `bf6479dc83bc52bd8970e018e58308e8c5c4aff3` | `ef8e126965080939729496bf9dfa36288bf92bbd` → `e54b33f20fc6fbd1c6f2974e28ff8ffd045033f5` | `5ba9900ddfd6eed5a03b8c0763d7eb555c7d9574` | [translation归档](#r1-translation-acceptance) |

归档按原文件逐字保留，包括历史基线、命令、job、原exit、Errors/过滤范围、MD-02/03与TR-04窄签及未决红灯；代码围栏里的相对路径仍相对原插件。旧文出现的三个ACCEPTANCE路径此后指向上表原文归档，并不表示文件仍在插件目录。历史判断与当前结论不改，本文较新的范围说明继续优先。本次是审计载体兼容迁移，**不是代码迁移、测试移植或ledger A增长**；主线接受条件是净diff只含四个已授权路径及最终tip官方§5回执。未扩写allowlist、未运行Rust或无变化业务专项。

删除原路径前已将每个归档围栏内容与工作区原文件、固定review的Git内容逐字节比较，三者完全一致：integration 102行/11501字节、media 115行/12279字节、translation 126行/15824字节，共343行/39604字节。先完整保存并校验，再用逐文件patch撤回新增文件；没有整批checkout/reset或删除目录。

### ledger机器合同核验：不会因归档提升B

按C1补充要求，亲读 `scripts/electron-migration/ledger.mjs:72-77`：没有插件ACCEPTANCE时是 `{ok:false,state:'missing'}`，不是ok；存在时按所有未勾选行计数。`lib/ledger-core.mjs:117-122` 的command B为 `dead || (A && specDone && review.ok)`。使用实际 `lanes.md` 目录及同一未勾选正则，对所有lane分别读取main、搬迁前固定Git内容及当前工作区计算，原退出码0，`changedReviewOk=[]`。本轮实现/SPEC/审批不变，A与B均不因搬迁增长；未修改ledger或添加替代checkbox。

| lane / 扫描目录 | main基线 | 搬迁前R1 | 搬迁后R1 | review.ok |
|---|---|---|---|---|
| L01 / llm-providers | open:10 | open:16 | open:16 | false → false |
| L02 / llm + translation | open:8 | open:12 | open:6 | false → false |
| L07 / agent-skills | open:19 | open:18 | open:18 | false → false |
| L18 / media | missing | open:4 | missing | false → false |
| L22 / integration | missing | open:1 | missing | false → false |

明确保留区别：L18/L22的**state标签变为missing、机器不再计原finding条数**，但仍阻止B且与主线原基线一致，不声称状态文本未变或它们已通过；完整open问题及证据在下方归档。L02剩余6个未决checkbox、L01/L07原未决checkbox均原样保留，归档内任务框不会被ledger读取，也不冒充插件级机器标记。净差检查的标准是四个授权路径，主线由协调者正常集成，不以审计搬迁充当业务增量。

## 自动续派增量核对（2026-11-05，main a9683a43b）

正常merge得到 `1400eab33`，本轮只读比较 `57e8c4375..1400eab33`：三个被验收插件、F4 json-exact、F7 tokenizer、L04/L03、L16生产代码及F3 storage均无diff。原八类检查的实现/测试依据没有变化，不重跑旧OCR/tokenizer/preview/ToolCall专项，也不将待owner修复项勾选。

新main的X5普通回答用例 `host/e2e/streaming/normal-answer.test.ts:37-87,90-121`确实通过send入口、实际HTTP/SSE和真实落库/terminal读取；但宿主 `__fixtures__/host.ts:67-75`明确注入FakeLlmAdapters与signedOutCodexAuth，场景不调用工具。它不补L01真实parser、L02精确usage/SQL组合或L07中央准入dispatcher证据；本轮仅审读它对R1阻塞条件的影响，没有声称亲跑X5或签完整模型链。`chat-pipeline/src/execution-runtime.ts:215-224`仍查找未提供的chatToolRuntime。三lane结论及3/6/2未决组保持。

上一轮最终正式收据已亲读：tip=`57e8c43756d3438f3e6df2a692ca23bf0496aa29`、base=`c6309183c4cddc06b3647530f3306f7906f2295b`、ok=true、failed=[]、at=`2026-11-05T00:34:42.298Z`。**这是基线允许放行，不是所有子作业exit0**：tests `20261105002514-4b02e9`原exit1，2490passed/1failed/3skipped，492.40s；唯一失败为translation/tests/c1_cross_lang.test.ts的set_params_rejects_incremental_job_with_english_removed_message，`backup/index.ts:311`调用registerFinalizer、测试`:47-50`的storage夹具缺该方法。失败key确在main全量650ddffbe基线，完整日志无Unhandled/Errors段。旧9ff的tests `20261105001426-41c703`同一失败、原exit1；不追溯改绿。C1已收到完整原码/失败栈及owner转修请求，本轮新main仍未改该夹具；R1没有实现/测试修改权限。

同期独立恢复检查：typecheck `20261105000325-29ea99`原exit0；strict boundaries `20261105000340-9c9d7b`原exit0，2949files/0violations/232个已登记suppressed；ledger `20261105000325-738d6a`原exit0，原末行如下：

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 16 (unknown 3633, not vetoed)
```

**本轮可执行复核已完成，无新增可签修复或解除的依赖阻塞。** 剩余问题已完成审读并归还实现owner，非宣称业务迁移全部完成。恢复条件：对应原finding的新main实现/测试、F4 typed reader、F7系统OCR平台绑定、或L03真实准入/usage消费组合到达，再按原编号最小复验。独立review不修改LANE/SPEC/TESTMAP或实现；该续派状态记在本授权审计文件。报告提交并merge后按§5取新最终tip官方gate，回执只在最终回复/协调信箱记录，避免gate后再补文档改变tip；旧57e回执不代新tip。

## 2026-11-05 Linux续作：本轮有效结论

恢复时HEAD `e54b33f20`、工作区干净；执行log/status并读取三插件LANE/SPEC/TESTMAP/BLOCKERS及本报告历史，正常merge main得到 **review `13fd67329` / main `e9df01a3c`**。保留既有命令/原测试抽样审读，从候选待签收及当前门禁继续。本节及各ACCEPTANCE最新节优先于后文历史表；本轮只编辑授权的四个验收/审计文件。

| Lane | 当前B结论 | 未勾选父finding/组 | 最严重剩余问题 |
|---|---|---:|---|
| L01-llm-providers | 不通过 | 3 | 系统OCR支持平台绑定；V2-02 usage/ToolCall跨owner精度；V2-03 typed首错/IgnoredAny/成功token字节路径 |
| L02-llm-manager | 不通过 | 6 | raw usage数字/字段选择及真实SQL链；预算原文serde；配置原文重复字段/整数及错误语义 |
| L07-agent-skills-ptc | 不通过 | 2组 | PTC实际中央准入调度；workshop typed接受集与完整工具消费；另有既登记的平台验证边界 |

### 本轮签收与事实纠偏

**C1新续派ToolCall窄签补充**：已确认bcf3f55c3/ef6f58cd6及09af85402、7aa600278/dd9543354、0ddfb4d8e均包含在独立实跑基线13fd67329。亲读Rust providers/mod.rs:328-335,2742-2823与真实adapter/共享数值出口，复用job `20261105000325-ee59c8`的tool-call-numbers.test.ts **6passed、过滤0/skip0，整作业原exit0**，未新增专项runner。签Anthropic base/partial数字及合法null、fallback/事件顺序、OpenAI标准字符串与非标准对象旁带clone/stringify出口。L02/F2未消费、裸scalar/args_json未知、完整模型链、D3/typed父项不关闭；详L01 ACCEPTANCE §20。OCR/tokenizer旧矩阵不重开；在途官方gate只取同一次结果，不起副本。

1. **L01中断前候选已独立复验**：`24df140c2`及实际实现/测试 `5b12dc109/2bd9e7e9b`均在main，4条真实HTTP/Host向量通过；只关闭HTTP **Value** UTF-8子项。时间四标题、typed负零三标题和workshop新文件已由恢复基线实际执行，复用该结果，未再追加旧最小runner或preview probe。
2. **L01时间/typed -0指定子项签收**；三类struct sequence已有真实实现及活动向量，不再报告全部拒绝。原L01-01/03的提供方、L02主要发送/异步Model2/OCR消费与03.b.1已有独立签收，更新父项勾选，剩余精度明确沿V2-02登记，不再让已修接线永久保持红灯。L01仍3组未决，见ACCEPTANCE §19。
3. **L02-06原三处日志遗漏关闭**；05数字模型id及字段校验已修，03 raw record调用/F3服务已提供，08的L16消费已main。原文/数字/组合测试残差分别保留，见ACCEPTANCE §11。02仅既有指定tokenizer签收，不把缺包故障重复派回。
4. **L07 workshop元数据/marker/hash及精确receipt子项通过**：新文件12条实际通过；unknown仍skipValue、sequence仍beginObject，完整工具链未接。L04已读取toolExecutors，缺的是L03 chatToolRuntime/真实admitted dispatcher，非“没有任何registry消费”。48条PTC保pending，见ACCEPTANCE §15。

### 亲自运行：恢复基线（原始摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/llm host/plugins/agent-skills
 Test Files  135 passed (135)
      Tests  1654 passed | 1 skipped (1655)
   Duration  258.46s
[作业 20261105000325-ee59c8] 退出码 0
```

完整日志 `/home/dsdev/.oc-jobs/done/20261105000325-ee59c8.log`，无Errors/Unhandled/FAIL，有WASI ExperimentalWarning。llm过滤同时命中llm-providers；逐文件统计如下，避免重复计数：

| 目录 | 实跑文件 | passed / skipped | TESTMAP正文 ported / pending | importable | wiring原结果（exit0） |
|---|---:|---:|---:|---|---|
| llm-providers | 22 | 354 / 1 | 246 / 0 | `importable: ok` | 合计 ported 246，其中所测模块未从 index.ts 接入 0（0.0%） |
| llm | 78 | 847 / 0 | 666 / 1 | `importable: ok` | 合计 ported 666，其中所测模块未从 index.ts 接入 0（0.0%） |
| agent-skills | 35 | 453 / 0 | 303 / 48 | `importable: ok` | 合计 ported 303，其中所测模块未从 index.ts 接入 0（0.0%） |

导入/接线命令分别为 `node scripts/electron-migration/importable.mjs host/plugins/<目录>/index.ts`、`node scripts/electron-migration/wiring.mjs --lane <目录>`。三表均0merged/0obsolete，无相应待审批行；L01额外preview depth128向量在PENDING.md单列，不算原Rust测试、也不算通过。三表生成头均有陈旧统计，交其owner同步，不由review改TESTMAP。

类型检查job `20261105000325-29ea99`：`npm run typecheck:host` → `tsc -p tsconfig.host.json`，原退出码0；本次Linux基线未发现import路径大小写类型错误。提交前再次merge得到 `39e92d3fa` / main `c6309183c`，只带入两个调度脚本变化，三插件源码/测试无变化，不为该合并重跑专项。

### 本轮确认仍适用的共性问题

- **typed原文与Value不能互换**：L01全Value预解析、L02 JSON.parse后校验、L07 unknown的skipValue都会丢失Rust类型/输入顺序/忽略字段语义。已修子项应单独签收，不能用同一测试文件通过覆盖尚未实现的分支。
- **Host对象不是IPC终点**：L01/L02 usage及L07 workshop输出还参与内部消费/持久化。只有真正wire边界才可按D3舍入；工具名/JSON字样不构成豁免。
- **机械可达与实际消费不同**：三条wiring均0unwired，L07仍无真实准入dispatcher，L02 recorder seam测试不能证明SQL组合；同样不能继续说已发布的F3服务或L04 registry不存在。

以下保留2026-11-04各轮原始证据；旧结论不覆盖上面的当前状态。

## 最新结论：standard-v2复验闭环与新增覆盖（2026-11-04）

**TR-04 main独立签收**：固定review `23ffb8c1a46e4f2fae2268481c4f44d98c00bae2` / main `fb463060d162d6c261ebb731180bcfaa833e95a2`，a747b6e89对应三源码/测试文件与当前无diff。job `20261104165619-790745`仅ocr_command.test.ts，6passed、42.32s、原exit0、无Errors/Unhandled（WASI warning不当失败）。原两decode_payload断言、成功/失败清理、调用方文件保留、校验次序、缺文件ioMessage、dedicated服务取消及1×1大字节PNG再编码实跑通过。TR-04指定公开命令/生命周期缺口闭合；不签大像素/D5/PSNR/平台，保存/metadata/registry pending不搭车关闭。详细证据见translation末节，与D11单例各保固定基线。

**23ffb8c1a官方收据与原码**：selfgate tip23ffb8c1a/basefb463060d/ok=true/failed=[]，at=2026-11-04T16:57:01.047Z。165103-23127a类型、-ce8b10边界、-c3c8c1导入、-d7888d测试均原exit0；测试2370passed/3skipped，无Errors/Unhandled。本次是子作业真实全通过，旧ab8f基线放行/原exit1历史不改。新报告提交后的官方收据不能沿用此旧tip。

**D11新条件：tokenizer原失败单例已通过（2026-11-05）**：固定review `3149fdc0f8cf74836d258f144a21f10cffca76e6` / main `0ed7917b8543059dd66dfaa7d45c608a5de9bb25`，根正式tiktoken1.0.22接入。按C1只跑原tokens_command完整标题，job `20261104164359-e55d67` 1passed、11.31s、原exit0、无Errors/Unhandled。真实kernel命令覆盖短文本/模型选择/特殊token/空输入及精确返回形状，详见llm ACCEPTANCE §10；没有额外手动跑六目录/2329。旧162908-9a1f2c exit1及ab8f的基线放行不改历史，不外推整算法/平台或Argon2功能通过。

**L01深度覆盖拆分静态确认**：938d45b93尚非main祖先；d1dd整组skip同时跳过127合法向量的不足已修，现127是活动ctx测试，只有128正确接受单独pending。未恢复错误拒绝、未改typed -0/Value/已签preview，原三标题最小计划不扩；提供方1pass/1pending/21过滤和五项gate不作独立证据。按C1最新§5澄清，报告commit/merge后运行官方固定门禁记录本tip；减少手动重复不作为官方gate豁免，门禁结果与业务签收/依赖事实分别报告。

**两项后继候选静态确认**：L01 d1dd22ed6仅在typedI64/U64拒绝原文-0，StoredSession/OAuth/Preview known字段接入，Value规则不变；错误unknown-depth测试改正确方向并明确pending。d1011cf16仅文档/提供方门禁，不当实现或独立绿。L07 38e43cbfe撤四处receipt Number化，811c5a83c两条真实Host对象/文件流程精确断言保留u64MAX版本及大file size。四提交均非main祖先，本轮未运行；分别见L01 §18与L07 §14。main后负零仅三标题、workshop仍原新单文件；时间/preview/usage不混签，first-error/unknown/sequence/工具消费与48PTC仍未决。

**OCR候选仅收件/后续最小范围**：3db0b4737组合、69fbbb8ee实现、6029c2ac3/70278cd4e测试均非main祖先；只核stat/标题，不冒称完成实现审读。提供方并发期154626-f3d816的5pass不计独立。main后仅ocr_command.test.ts（两decode_payload及清理/保留/校验/取消/再编码）；1×1大字节PNG不证大像素/PSNR。translation TESTMAP两原测试仍pending，交实际写者，不由review改表。TR-04未签，已抄C1。

**L07 workshop UD0004/0005候选窄核**：3d6108625实现、82564b117新测试均非main。原文typed已知字段、metadata/version饱和/hash/marker精度静态修复确认；unknown仍skipValue且struct只beginObject，未获IgnoredAny/sequence等价。propose/list/apply receipt在Host Record返回前Number化，Rust output还进入ToolResultInfo/save_tool_block，不能由“工具JSON”命名视作IPC。候选未见workshop真实注册消费；L03通用history的output序列化/保存说明内部消费者要求，不冒称该链已接。详见L07 ACCEPTANCE §13，沿X6-UD-0004/0005登记残差，main后仅新workshop-json文件；提供方26/10pass不当独立结果，48PTC/停放/平台范围保持。

**2026-11-05 F4依赖候选窄核**：b6dc607f7尚非main祖先；skipIgnoredValue经公开JsonReader方法，独立迭代栈/纯词法数字/不配对代理项/不消费typed深度与§16锁定Rust源码相符。旧skipValue/nextKey自动丢弃仍不同，L01必须显式消费；F4小typed夹具与所报16pass/候选门禁不替代L01生产入口复验。仅静态确认依赖面，未新增job或签领域；见L01 ACCEPTANCE §17。L01新增诊断回执只记来源，preview已签精度、时间四标题计划和usage范围不变。

**V2-03独立源码纠偏（typed/Value/IgnoredAny）**：亲读Cargo.lock锁定serde_json1.0.149、serde_derive/core1.0.228本地依赖源码，未运行Rust/TS。确认typed i64/usize对-0走F64而拒绝，Value arbitrary_precision另路归I64(0)；derive逐键typed解码，后重复不能抢先；未知值走IgnoredAny无Value的递归/代理项配对/数值构造约束；普通struct接受相应sequence。L01当前全Value预解析/duplicate预检不等价，沿用L01-V2-03未决；F4 skipValue=readValue也不能直接冒充IgnoredAny，需共享reader owner补面。

**纠正此前验收语义**：§11将preview未知x深度128拒绝认可为serde等价不成立，已撤回该子项；5passed的运行事实仍保留。typed -0现有用例的支持方向同样需owner纠正，真正Value路径不一并否定。preview bigint两标题+probe签收、Paddle Value深度子项保持，不重跑、不改测试。详细锁定源码位置/输入顺序/seq例子在L01 ACCEPTANCE §16。无新runner，不继承提供方诊断为独立结果；时间候选/usage不搭车签。

**preview内部usize精度子项已main独立签收（review `e65cf1738`）**：cff1b69ad/3f2fb4e04/4700ab5f5已main且相关文件与已审候选无差异。原计划job `20261104153804-201f16`仅两标题2passed/14过滤skip，8.24s、原exit0；原输入probe `20261104153804-12432d`断言2^53/+1精确且不同、page_count=u64::MAX，原exit0；均无Errors/Unhandled。详见L01 ACCEPTANCE §15。仅关闭V2-02预览子项，Codex时间候选、usage链及其他D3/平台/消费边界不搭车签收。

**Codex内部时间新候选静态复核**：b22f519b8实际实现/四新测试、d8dcc68d9实际公开CodexAuthState/服务断言、3306483dd仅文档，均非main祖先。确认store→Host状态/requestAuth→OAuth clamp/satadd→lossless持久化保bigint，仅auth_status命令DTO转number；原IPC舍入/保密/刷新字段断言保持。L01提供的151846红、152740绿83/typecheck只记来源，不当R1独立结果。报告§14列main后四标题最小job，本轮未运行；preview两标题+probe与usage提案各自保留，rate-limit/generation/重复首错及D3全域未签。

**usage提案限定静态核对（1fafde929，非main祖先）**：仅文档，未实施ProviderUsage公共类型。已逐段核L01原文/clone→L02 snapshot/hook/single-shot→L03独立parse→F3 u32 SQL→真正wire；支持L02先presence后as_u64/u32截断、cache各自as_u64/max/clamp，L03保独立有效pair/部分字段顺序。F3底层cacheDebugEnabled/queue/collector/SQL实现存在，缺正式llmUsage组合而非整算法不存在。详细源码映射见L01 ACCEPTANCE §13。

提案需补两个落点：当前kernel debug拒绝JsonFloat/非有限number，events内部listeners保原值，故最终wire适配需F1协调，不能在通用sink前wire化；公共cloneDbJson的普通对象赋值对自有__proto__键不保真，“未知字段全保留”需工具owner在现有实现保障。另明确L02 snapshot整对象clone和single-shot的i64零/非零条件。全为静态，未跑测试/探针/322、无新job、不签提案完成；L02/L03/F3停放状态按C1保持，旧preview两标题待main计划不变。

**L01 V2-02预览新候选限定审读**：固定cff1b69ad，3f2fb4e04实际将page_index/page_count改bigint并添加2^53/+1区分断言，4700ab5f5实际修复无原文Host number=2^60的精确回退；7fbd14169只LANE。候选均非main祖先（exit1），原提前Number化反例在候选静态已修，当前finding待main独立运行。没有运行候选/旧main替代suite，没有继承322pass。L01 ACCEPTANCE §12列出两条生产服务最小过滤及原输入探针；provider usage/Codex时间/其他重复字段未决，f64/i32等新差异不搭车签收，旧Model2/OCR已签状态保持。

**L02-04积压子项续审（review `fc062c667`，本轮main无新增）**：审读尚未签收的已集成budget_commands修复，复用独立门禁131022-87fc5b日志461-463两条passed，确认缺字段/load-parse前缀/命令排除learner_profile子项，不重跑旧集。新增只读生产getConfig探针`20261104142602-d5ed8d`原exit0、无Errors，打印三处反例：1.0、usize溢出18446744073709551616及重复total_budget仍被接受。沿用L02-04父项保持未决，只将未修边界交回，不再派旧{}成功/上下文问题；完整源码、Rust与输入见llm ACCEPTANCE §9。未编译Rust、未改实现测试。

**L01文本边界新main复验（review `1393cc862` / main `bec9c35ba`）**：V2-03后继已集成，jobs `20261104140639-49937d` 5passed/5过滤、`20261104140811-9d3e75` 2passed/3过滤，均原exit0、无Errors/Unhandled。签指定重复字段/词法/递归向量、X6-UD-0041 Paddle非对象block及multimodal日志Debug变体名修复。没有重跑旧V2-01/309或六目录。

**V2-02仍未闭合的明确反证**：`page-indexer.ts:73-79`在内部服务提前把范围检查后的BigInt转Number；只读生产函数probe `20261104140708-2b73d4`输出两个相邻合法usize相等，u64::MAX回读为18446744073709551616，尚未经过IPC。Rust该DTO仅derive Deserialize；D3的IPC舍入许可不适用于内部预览服务。沿用L01-V2-02登记精度残差（并非另造同义编号），测试直接调用ctx服务却期望舍入的部分不予真实性签收；完整复现/源码/范围见L01 ACCEPTANCE §11。L12文本服务生产消费仍未见，沿用owner已列阻塞。

**续派证据补记（review `ddb6550bd` / main `16a254adf`）**：本次main仅门禁规则变化，六插件实现/测试无新diff。复用已完成独立job `20261104131022-87fc5b`，L22两条真实Codex入口测试passed、表头157/29/4/53实数一致，签收IN-01这两个子项，29pending保留；L02 `87607ecdc`真实OCR prepareCandidates→runPrepared新增向量passed，关闭L02-01已识别的认证/准备阻断。详见integration末节、llm §8；整个原job仍exit1（2273pass/1fail/3skip），不改写成整作业绿。

恢复条件检查：root仍只有js-tiktoken、require.resolve('tiktoken')仍MODULE_NOT_FOUND，R1授权清单仍缺三新增ACCEPTANCE。新gate基线判定用已有失败日志只读计算，相对158eaacf1仍为新增1项/ok=false；规则变化没有解锁当前失败。按C1精确指令不重提六目录，不写/改selfgate；最后真实收据仍对应ce6bab375且ok=false，不能冒称为当前新tip收据。三新增授权及正式依赖继续由架构师/C2跟进。

**L07-05最新签收（review `b70b5e238` / main `ad11a8394`）**：ddcd6dde9和1bef65e53均已main；按C1指令亲跑§11原定最小job `20261104131936-08027e`，7passed/42过滤skip、原exit0、无Errors/Unhandled。签收本地异步read、tap异步write两个Host同步I/O残差，MAX+1/open-read分段/虚拟清理/两处让出向量均实际通过；详见L07 ACCEPTANCE §12。不重跑V2-01/MD02/03或438专项，01与utilityProcess/打包/三平台边界仍保留。下文“候选未入main”仅为旧轮次状态。

**当前集成阻塞**：`lane-paths.mjs:34`仍为旧R1授权清单，拒绝三新增ACCEPTANCE；C1 main协调日志:1203/:1222/:1319已有新增授权/报告接收。已正式escalate `2026-11-04T131559633Z-R1-review-llm.md`，请求基础设施owner补三个精确路径，不自行越界改调度权限或删除独立报告。另官方selfgate tip=b70b5e238/base=ad11a8394/ok=false/failed=[tests]；jobs `20261104131022-51f587` typecheck、`-283922` boundaries、`-ace2e8` importable均原exit0，`-87fc5b` tests原exit1（2273passed/1failed/3skipped）。唯一失败tokens_command.test.ts的MODULE_NOT_FOUND tiktoken来自F7 native/tokenizer/index.ts:19；根package只有js-tiktoken、共享node_modules无tiktoken，F7 NEEDS:75已申请1.0.22。C1/C2/F7均queue成功，依赖/授权owner修复前不声称整分支绿。

**L02续派main复验（基线`a17989895`）**：发现99d95149a及异步Model2后继已集成，执行§6原计划最小jobs：`20261104130602-cbcdf4`（Codex真实L01+L02/Anki路由服务，3passed）与`20261104130602-5205b2`（raw过滤，5passed/4filtered），均原exit0、无Errors/Unhandled。签收01活跃认证/主要调用与异步Model2指定路径、03 raw请求转换、08提供方子项；OCR准备/raw usage及L16未集成组合仍未决，父项数量不减。实现/边界与原始命令见llm ACCEPTANCE §7。

新核差异：`d9d4f5569`异步prepare/remote-image预取，`44e7e8a76`真实Model2消费，`fe2435e5e`补真实流式测试；不再沿用“Model2仍调用同步prepare”或“L02无remote-image调用”的旧描述。普通图片路径仅静态确认，未签全部图片消费。当前L07 ddcd6dde9、L22 3c76312fd/bf3848a66、L16 374914c1d、L01 V2-02 83a410cd4/d7d8c65ae均非main祖先。L11媒体files两个所需WithConn接口仍未发布；L07 toolExecutors的实际读取仍仅测试，已有多插件注册不等于中央调度消费。

**续派复验更新（review `2f83023df`）**：MD-02/03、L01 V2-01指定alias/null范围已独立签收。实现分别为`a34d959a6`、`372463c33`，均已进入先前测试基线`0ca6ebaa5`，到当前相关实现/测试无差异。复用本review官方门禁子作业`20261104120904-53776d`（原exit0、1445passed/3skipped、无Errors/Unhandled），其中media-commands 27条及services 3条实际执行通过；日志明确列出五条L18-M01和alias规则用例，未重复专项测试。具体分支/Rust对照见各ACCEPTANCE末节。MD剩4父项，L01 V2-02与原父级边界保留。

首次门禁外层因120s前台超时未生成收据；后续按续派要求merge main并后台运行官方lane-gate，已收到`2f83023df`/main `45c3250b0`四项全部通过通知。该收据属于此提交；本次新增报告提交需重新按§5生成对应收据，不将旧tip收据用于新tip。

已读取官方`.oc-runs/selfgate/R1-review-llm.json`：tip=`2f83023df4384bf14df42173fb1adb11011b29f3`、base=`45c3250b0d4bd67ade44c04fcab27e650db86c13`、ok=true、failed=[]、at=2026-11-04T12:47:04.149Z。四个jobs为`20261104124236-d8405d` typecheck、`-e62f34` boundaries、`-cfcc33` importable、`-3786e1` tests，原code均0；测试1445passed/3skipped，四份日志无Errors/Unhandled。未手写收据。

后继更新：L07-05 `ddcd6dde9` 异步本地读取/导出写入候选已静态确认，`1bef65e53`仅文档，尚非main祖先（exit1）。05待main最小独立复验，02/03/04/06/07/D3旧签收不撤；最新候选证据及最小命令见L07 ACCEPTANCE §11。没有新runner、没有重跑ledger/438全套。

本轮main快照`eeaf5bdc7`（review merge `21cc05604`）。按v2优先闭环：**L07-02/03/04/06/07及D3指定修复已独立签收，L01-03.b.1已签收**。L07-01真实dispatcher与05剩余同步大文件I/O/运行平台边界保留；01的PTC测试统计纠偏不因本轮其它用例通过升级。旧段落/表中的未集成、未运行和7个未决L07均为历史，以下表是当前父finding口径。

| 插件 | 当前结论 | 未勾选父finding数 | 最重要剩余项 |
|---|---|---:|---|
|llm-providers|不通过|4|原父项及V2-03 typed首错/接受集；V2-02预览精度已签，时间候选/usage等其他范围未签|
|llm|不通过|7|01已签；tokenizer缺包/指定短文本命令已复验，完整范围、raw usage、L16组合等仍未决|
|agent-skills|不通过|2组|真实L04 dispatcher；workshop UD0004/0005 typed/receipt残差；05已签，运行平台仍未验|
|translation（新增）|不通过|6|TR-04公开OCR指定路径已签；其余流/保存/registry等原父项未决|
|media（新增）|不通过|4|MD-02/03已签收；files所有权、文档解析、同步I/O、OCR策略/账本仍未决|
|integration（新增）|不通过/证据未闭合|1|表头/Codex两条已签，剩29pending；不重复制造X1已回归的命令panic|

新增独立报告：`host/plugins/translation/ACCEPTANCE.md`、`host/plugins/media/ACCEPTANCE.md`、`host/plugins/integration/ACCEPTANCE.md`。仅编辑验收/本审计文档，未改实现、测试、SPEC或TESTMAP。新增finding ID为R1-TR-01～07、R1-MD-01～06、R1-IN-01，均含Rust/TS位置、可触达分支、复现条件与证据级别。

### 本轮最小jobs结果（亲自取result，无tail截断）

| job | 命令目标/过滤 | 原始结果 |
|---|---|---|
|20261104105922-ff769c|L07 skill-package/local-read/zip-pool/connector-executor；仅MAX+1、local open/read、worker分类、d3_i64/过期边界|4文件，8passed/55skipped，exit0，14.96s|
|20261104111742-4e66b9|L07 package/market/files；仅dispose、安装时间/错误digest清理、deadline、warn|3文件，5passed/70skipped，exit0，9.33s|
|20261104105922-aff73e|L01 codex-auth-service；仅keeps Rust error-code Option-chain order|1passed/13skipped，exit0，6.53s|
|20261104110558-d338db|translation commands/policy/transport三文件|33passed，exit0，9.50s|
|20261104110558-927711|media document-parser/ocr-settings/media-commands三文件|73passed，exit0，23.50s|
|20261104110558-baedf5|integration app-state/llm-probe-helpers两文件|19passed，exit0，5.56s|
|20261104111058-b824c3|只读生产解析器差异Node探针|exit0，打印DeepSeek length误判反例（不是等价通过）|
|20261104111202-1f4963|只读真实streamTranslate断流Node探针|exit0，打印attempts=2/delivered=[prefix,prefix]（不是等价通过）|
|20261104111600-70bc2e|恢复要求：npm run migration:ledger -- --check --no-write|exit0，commands problems0/tests0/orphan0；不是B签收|

以上作业全部经全局job.mjs submit，提交后继续轻量源码审读，再取result。**均无Errors行**；media有WASI ExperimentalWarning。完整命令和原始输出在对应ACCEPTANCE及`/home/dsdev/.oc-jobs/done/<job>.log`。skip为-t选择过滤的旧用例，不能把总数当全部通过；本轮Linux非root的本地open/read两条实际执行。没有Rust编译/运行，没有utilityProcess/三平台验证。

### v2补审覆盖和证据边界

- media：审读18条真实命令、17条TESTMAP原测试；生产入口kernel suite+E3分支证据。findings中的硬编码running、读失败前取消和越权写SQL是源码明确反证，未冒称已跑新增异常向量。错误层级/日志/所有权/清理/阻塞均纳入。
- translation：实际5个注册IPC+1个缺失OCR契约，已全部审读，补9个复杂服务/流分支为15检查点；**不足15条不同IPC是实体范围限制，不虚报**。15条TESTMAP抽样，同一问题另有真实TS传输反例，现有33条测试绿不能覆盖反例。E3+TS探针不是Rust动态差分E1。
- integration：index实际0条命令，且没有L22命令契约文件；审读唯一生产服务，17条TESTMAP抽样，15条外部命令错误入口交叉引用X1§0.4与C2派工。明确这些不是15条本插件命令、也不是R1本轮亲跑15条。X1已测合法业务错不重复派回，X1全profile exit1/降级原文不改成全绿。
- 没有新证据时不将“相似能力”“同文件可达”“只测替身”升级为完成。翻译保存复制L11仓储、媒体直接UPDATE files属于共同单写者问题；需owner公开业务接缝，不通过删除副作用规避。

### 新到候选，仅作版本记录

C1 V2-01：`372463c33`为alias重复/null实现与公开ctx测试，`8282828f5`仅文档；本轮仍非main祖先（exit1）。对Rust page_indexer.rs:18-50静态确认指定serde规则修复，尚无独立runner，L01报告§10记录待集成只跑services对应新用例。未签完整usize精度或其它整数审计。

L07统计候选`13aca0f98`本轮非main祖先（exit1）；48条PTC改pending/303ported是v2真实性纠偏而非已验证功能回退。当前main351ported与候选口径分开；本轮签其它finding不顺带恢复01/PTC完成声明。

### 交付与实际投递

报告提交`a72ef7dee`（L01自动检查点）、`bf6479dc8`（L07签收及三个v2补审）。已用`coord.mjs queue ... --from R1-review-llm`分别向L02-llm-manager、L18-media-docs、L22-app-commands发送对应finding/复现/范围，并向C1-app发送闭环及新增问题汇总；四次均返回“已投递”、exit0。是进入协调队列，不声称owner已修或已签收。未使用`--now`打断其他lane。

### L07-05新异步I/O候选的限定审读

固定`ddcd6dde9`：`src/skill-package.ts:835-867` await stat/open/FileHandle.read/finally close，保留MAX+1及open/read错误阶段；`src/skill-taps.ts:226-251,471-475` await本地写/虚拟暂存写/删除，exportTap等待完成后再返回。Rust对照skills.rs:2378-2413、skill_taps.rs:693-732,762-884（均src-tauri/crates/dstu-agent/src/chat_v2）。原同步磁盘I/O问题在候选静态已修，不再重复派回；不扩称Host没有任何内存复制或全部同步任务已验。

测试改动保留原MAX+1累计、末次1byte、无后续读取，以及虚拟writer成功/失败后staging清空、local bytes/path等断言；新增两条setImmediate让出向量调用真实production方法，只替换增长读取的外部FileHandle.read seam。独立runner待集成，C1的115144-605733/114750-ece318结果只记来源，不计为R1实跑。utilityProcess/打包/macOS/Windows仍未验，05父项当前不勾选，01/PTC保持未决。

同消息提及L01 V2-02 `83a410cd4/d7d8c65ae`实现与`a7b3c807a`仅BLOCKERS已记录为owner继续审计队列；本轮没有被委托完成其重复键/词法/整数全分支签收，也未凭提供方309绿扩签。没有重新审已确认V2-01或03.b.1。

---

以下保留各轮历史基线与证据；与最新签收状态冲突时以上节及各ACCEPTANCE末节为准。

日期：2026-11-04。实现基线：`f23c98702`；工作树/分支：`ds-mig/R1-review-llm`。

协调者指令 1 定向续审：main 快照 `35b4fbfdf` 已通过 `12fab466c` 合并；L01 ACCEPTANCE 冲突保留独立报告。仅复核 L01-04、L02-07/08 与 L07 新收集器对 L07-01 的影响；下表更新为本轮未勾选数量，其余初审细节/全量测试输出作为历史证据保留。

第二次定向续审（L01 新提供面）：`080c16d34` 尚未集成 main（祖先检查 exit 1），本轮仅静态读候选 Git 对象，未合入/摘取实现，未运行任何候选/旧源码测试。L01-01/03 有已核实提供方子项，但端到端及 runner 仍待，父项状态与下表数量不变。详见本报告末节及 L01 ACCEPTANCE §6。

第三次定向续审（L07 完整候选）：`7455ad39f` 尚未集成 main（祖先检查 exit 1），按新 quality §10 / decisions D1～D6 只读核对七个修复编号。所报代码修复均存在，但 L04 消费、ZIP worker 残留分支/错误分类及 C1 已派回 D3 bigint 回归仍未闭合；未运行 runner，七个父项暂不勾选。详见末节及 L07 ACCEPTANCE §6。

第四次增量续审：L07 `111fab06a` 的 D3 子项静态修复确认，旧“大整数被拒绝”不再适用于新候选；L01 `c7fe0a752` 的03.a/c/d/e所报机制静态修复确认，03.b主链接入但错误码回退顺序仍不同。两候选均非 main 祖先（exit 1），本轮无 runner/job；仅更新指定子项，父级 B 结论不变，见末节与各 ACCEPTANCE §7。

**第五次运行基线更新**：已合并 main 快照 `97ffb137a`（merge `699e04283`），L01上述候选提供面已可运行。全局队列作业 `20261104062852-4bb63e` 独立验证 remote-image/codex-auth-service：2文件16 passed，result原退出码0，无Errors行。旧“L01未集成/未运行”仅为历史记录；父级未决03.b.1、L02消费和系统OCR不变。

第六次候选增量：`ae76da7d3` 的03.b.1与`db5bfe8f5`的L07-05两个repack/worker分类已静态确认修复；两候选尚未入main（ancestor exit1），无独立runner。L07-06新向量有平台静默return与精确MAX+1断言不足，详见末节；旧代码缺陷不再套用于新候选，父项仍待集成/验证。

**第七次仅06后继更新**：`b34d4cbaa`已修复上述平台静默return及MAX+1断言不足，两项静态确认勾选，不再派回。候选仍非main祖先（exit1），独立运行待验；本轮未重审05/D3，详见末节和L07 ACCEPTANCE §9。

**第八次L02限量续审**：固定`99d95149a`与L16`18c563a46`，均未入main。01活跃认证和主要共享发送、03真实provider转换、08路由提供及L16消费代码已确认；旧“API缺失/完全没接线”不再套用。usage、同步Model2/OCR Codex预检及独立集成验证仍待，详见L02 ACCEPTANCE §6及末节。

## 汇总结论

**三个 lane 均不通过 B 级。** 单测和可导入检查通过，但仍有已证实的业务差异、生产接线缺失及测试账本问题。以下问题数按各 ACCEPTANCE 的未勾选“必须修复”编号计，联合问题分别列在提供方/消费方，不代表去重后的独立缺陷总数。

| Lane | 结论 | 必须修复数 | 最严重的 3 个问题 |
|---|---|---:|---|
| L01-llm-providers | 不通过 | 3 | L01-01 图片预取待L02实际消费；L01-03 错误码回退顺序/消费者未闭合（提供方服务已实跑）；L01-02 macOS/Windows 系统 OCR 无生产绑定 |
| L02-llm-manager | 不通过 | 8 | L02-01 候选主要共享认证已接、同步准备仍缺；L02-03 provider转换已修、usage仍缺；L02-08 路由提供/L16消费已有候选、集成独立验证待验 |
| L07-agent-skills-ptc | 不通过 | 7 | L07-01 PTC 未进入生产工具注册表；L07-02 安装校验失败泄漏 staging；L07-05 ZIP CPU 工作阻塞 Host 事件循环 |

详细文件：

- [L01 ACCEPTANCE](../../../../host/plugins/llm-providers/ACCEPTANCE.md)
- [L02 ACCEPTANCE](../../../../host/plugins/llm/ACCEPTANCE.md)
- [L07 ACCEPTANCE](../../../../host/plugins/agent-skills/ACCEPTANCE.md)

## 定向续审：编号 → 提交 → 入口 → 验证结果

| 编号 | 提交证据 | 真实生产入口/缺口 | 本轮验证命令及退出码 | 结论 |
|---|---|---|---|---|
| L01-04 | `cae3f01ef` 仅改文档；实际测试与 TESTMAP 修复在 `856022db9` | 测试从 `llm/api.ts:26-30` 调真实 policy；L01 `index.ts:31-41` 提供真实 adapters；L02 `index.ts:100` → `ocr_hedge_service.ts:84-94` 为实际 reasoning→adapter 消费之一 | `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/deepseek-harness.test.ts --maxWorkers=1`：14 passed，exit 0 | 独立逐条对照 Rust 的 8 条新增断言后关闭 L01-04；不授予 lane B |
| L02-07 | 路径修复 `b4a896023`；最新 TESTMAP 状态 `4a9650c08` | `index.ts:91-95` 新服务已提供，但剩余 pending/未接线仍需逐项完成 | `node --input-type=module` 只读路径/原测试名核查：662 ported、missingPathOrName=[]，exit 0；`npm run migration:ledger -- --check --no-write`：全仓 tests problems 21，exit 1 | 原 229 行/27 文件路径问题已修；当前 662 ported/5 pending，旧表头及 SPEC:16-24 仍未完成，整项不勾选 |
| L02-08 | 没有接通 Anki routing 的修复提交 | `llm/api.ts:152-175` 与 `src/service.ts` 无 Anki 路由方法；buildSlots/planRouting 无非测试调用。Anki critic 的 DI 接口/调用不是 L02 实现 | `rg -n 'anki_model_routing\|buildSlots\|planRouting\|probeAnkiRouting\|resolveAnkiRole' host -g '*.ts' -g '!**/tests/**'`（正则 alternation）只读检索 exit 0；无修复，不重跑旧纯函数测试 | 保持未勾选 |
| L07-01 | 新收集器 `358e562d6`；文档 `789669c5c` | `index.ts:146-162,220` 仅创建注册收集器；没有 PtcExecutor 实例化/注册/中央准入执行 | 全 host 非测试检索 `PtcExecutor/ptc_run/runPtcScript` exit 0；测试未运行，退出码不适用 | 保持未勾选；收集器和 roster/descriptor 名称不能证明 PTC 可执行 |

L01 新增 8 条测试的 TS/Rust 行号、每条断言和 14/14 原始摘要见其 ACCEPTANCE §5。路径核查直接读取每条 TESTMAP 的目标及原测试名，不修改测试；它只能证明目标有效，不代表 662 条全部本轮实跑。ledger 21 为全仓数，不能都归责 L02。

本轮未重复三套全量测试，未根据实现者自写 B 统计关闭其他编号。macOS/Windows OCR 未验证；L01-01～03、L02 其余编号和 L07 其余编号保持原独立勾选状态，等待对应修复提交及限定范围复核。

## 初审覆盖与证据口径（历史基线）

| Lane | 命令审读 | 原测试真实性审读 | TESTMAP 实际状态 |
|---|---|---|---|
| L01 | 全部 5 IPC + 10 内部/服务路径；契约仅 5 条，无法抽 15 条不同命令 | 15 条 Codex：包括保存/取消竞争、登出失败、状态和错误分类 | 238 ported / 8 pending；前置 L02 policy API 已发布，旧阻塞说明过时 |
| L02 | 18 IPC，涵盖配置/安全存储、预算、恢复、取消、OAuth、raw prompt | 15 条 Anki routing：断言对应，但生产不可达 | 659 ported / 8 pending；229 行的目标路径不存在，另有未接入模块误标 |
| L07 | 15 IPC，涵盖文件、ZIP、tap、market 与安装回滚 | 15 条 market + 7 条 PTC；另核对显式 rollback 测试 | 351 ported，但 PTC 没有生产注册；0 pending 的声明不成立 |

全部证据和逐项通过/问题结论都记录到 lane ACCEPTANCE，含 TS/Rust 文件:行。没有修改实现、测试、SPEC、TESTMAP。没有编译或启动 Rust；规定的 TS 测试使用了仓库已有 Starlark WASI 产物。没有操作线上服务器或生产数据。

### 初审测试实跑结果

| 指定命令的路径参数 | 原始测试结果 | 耗时 | importable | wiring |
|---|---|---:|---|---|
| `host/plugins/llm-providers` | 18 文件；278 passed / 1 skipped | 11.89s | ok | 238 ported / 0 unwired |
| `host/plugins/llm` | 75 文件；1016 passed / 1 skipped | 46.59s | ok | 659 ported / 0 unwired |
| `host/plugins/agent-skills` | 29 文件；406 passed | 19.74s | ok | 351 ported / 0 unwired |

执行形式：`npx vitest run -c vitest.host.config.ts <路径>`、`node scripts/electron-migration/importable.mjs <路径>/index.ts`、`node scripts/electron-migration/wiring.mjs --lane <目录名>`；均 exit 0。每 lane 的原始输出摘要在其报告中。

**计数注意**：vitest 的 `host/plugins/llm` 子串同时匹配 llm-providers，不能把 1016 全计为 L02；L02 自身是 57 文件/738 passed。L01 的 1 skipped 是 Linux 上系统 OCR 委托测试的条件跳过，不能写成 279 passed。

另调用仓库 boundary `checkFile` 对三个插件生产文件分别扫描，未抑制违规均 `[]`。这是语法/边界规则检查，不覆盖生命周期、依赖是否真的注入、业务分支全等。

### 中断恢复后按要求补跑的 ledger

已执行 `git log --oneline -20`、`git status` 并核对三个 TESTMAP；当时分支未变、工作区干净。没有重复已完成的测试。

```text
$ npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
Exited with code 1
```

这是**全仓**门禁结果，不把 250 个问题全部归责本组三条 lane，也不把该摘要当作本 lane 的最终 B 比例。L02 的 229 个无效目标另由只读路径核查独立确认；未运行写入 ledger 的命令。结论落盘后不为刷新全仓百分比再跑同一检查。

### 一个直接复现的跨 lane 差异

给 L01 真实 `DatabaseCodexCredentialStore/CodexAuthManager` 和 L02 真实 `LlmConfigStore` 同一份符合 Rust serde 的 camelCase 会话（仅内存虚构凭据），得到：

```json
{"providerHasUsableSession":true,"llmHasUsableSession":false}
```

证据：`host/plugins/llm-providers/src/openai-codex/store.ts:19-29` 对比 `host/plugins/llm/src/config_store.ts:123-142`；Rust 的权威本来就是 `openai_codex_auth.status().has_usable_session`（`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:6423`）。修复需要 L01/L02 联合接线，单纯改键名仍不能反映活跃 reauthentication_required 状态。

## 共性问题（建议协调者回灌规范）

1. **文件可达不等于生产功能可用。** 初审 L01 setter 未绑定；续审 L02 Anki routing 仍无消费，L07 PTC 新增收集器后仍未注册。wiring 扫描 `import type`/re-export、从全部插件入口建全局图（`scripts/electron-migration/wiring.mjs:15,50-55`），无法证明服务方法/执行器被真实调用。验收需保留“入口→服务/工具注册→真实依赖”链条证据。
2. **wiring 的 0 unwired 可被旁支导入掩盖。** `wiring.mjs:74` 不存在文件直接跳过；`:76-78` 测试文件有任一已接入 subject 就算通过。L02 的 229 个错误路径、Anki 测试附带导入 config_store 就是具体漏检。应逐个被测模块核对，并让不存在的目标明确失败，不能只看总百分比。
3. **“仅失败分支”不是等价移植。** L01 远程图片未绑定→跳过、系统 OCR 无绑定→unsupported；L02 Codex 请求→配置错误。即便返回结构与 Rust 某个失败分支一致，也不能代替原来的成功能力。
4. **Rust 的隐式保证需在 TS 调用者处落实。** L07 prepare 的 Drop 清理和 spawn_blocking、真实 HTTP redirect 总 deadline 被漏掉；L02 serde 校验和桌面 tokenizer feature 被简化。移植单个类或同名测试不足以覆盖调用生命周期、运行平台默认值。
5. **没有 console 不等于日志已迁移。** L02 failover 解析失败及保存失败、L07 路径拒绝的 Rust warn/error 消失；现有静态 boundary 无法识别这种缺口。
6. **测试数字和登记原因必须与当前代码对应。** 初审发现 L01 的 8 pending 原因过时、L02 TESTMAP 表头/路径过时、L01 旧验收把 skipped 计作 passed。续审已确认 L01 的 8 条及 L02 路径修复；L02 表头仍旧。平台差异要标明“登记”还是“协调者已接受”，不能把实现者说明当批准。

## 已登记差异与待裁定事项

- L07 的目录交换退化 rename fallback、ZIP zlib/miniz_oxide 字节差异已在 SPEC:205,386 登记；本次核对实现后保留记录，**未确认这些差异已被协调者接受**。ZIP 字节用于历史 provenance 及 handoff hash，需同字节证据或明确裁定，不仅是可解压性问题。
- 移动端 content:// 不在本轮桌面实现范围；现有桌面明确失败分支与原平台边界分开记录。
- L01 原生 OCR/远程图片的 native-needs、L02 SPEC 的 Codex/usage 缺口是待完成依赖，不是功能删减许可。
- 三份 TESTMAP 均无 obsolete/merged 行，`migration/approvals.json` 无需为本次抽样提供此类豁免。pending 和虚假接线不能被审批表不存在自动合理化。

## 提交范围与后续复核

只提交三份 ACCEPTANCE 和本文件。协调者在审读期间自动检查点提交 `6016af015`、`e973c4888` 已保存 L02、L07 的阶段性结论；最终提交补齐验收修订及汇总，不重复或还原检查点。未勾选项由原 lane 修复后再逐项复核；本次不授予有条件 B 级。

## 第二次定向续审：L01-01/03 候选提供面

候选版本固定 `080c16d34`，`git merge-base --is-ancestor 080c16d34 main` exit 1。实现主体为 `718a21e23`，公共 API 实际在 `9c06e7943` 补齐；`8f2f28694` 补缓存 reader 卸载与文档，`080c16d34` 仅更新非 Codex 分支边界注释。

| 编号 | 静态确认的真实提供入口（候选行号） | 未决 | 测试命令及退出码 |
|---|---|---|---|
| L01-01 | `index.ts:33-48` 提供 prepareRemoteImages/同步缓存 reader；`src/media/remote-image.ts:123-131` → 真实 `host/platform/net-policy/index.ts:243-257` 下载 | L02 尚无调用；提供面真实不等于旧同步 buildRequest 已自动支持缓存未命中下载 | `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/remote-image.test.ts --maxWorkers=1` **未运行，退出码不适用** |
| L01-03 | `index.ts:55-77,86-115` 服务和五 IPC 共用一个 manager Promise；`api.ts:197-214,255-262` 发布 llmCodexAuth | L02 未消费；新增 prepare/send 还存在协议门控、错误响应归一化、超时边界、header 日志/错误映射差异，非流式桥接责任未闭合 | `npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts --maxWorkers=1` **未运行，退出码不适用** |

具体新增差异及逐条测试断言见 `host/plugins/llm-providers/ACCEPTANCE.md` §6（03.a～03.e）。关键 Rust 对照是 `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4069-4124,4690-4754,4815-4823,4995,5037-5090`；候选 `src/openai-codex/prepare.ts:63-98,141-159,175-210` 尚未覆盖同样保证。特别是 404 usage_limit→429 归一化不能省略，刷新后第二次 POST 的 timeout 应独立应用。

3 条图片测试确实安装真实插件、使用 loopback HTTP；5 条 Codex 测试中共享状态/prepare 三条走 service，401 两条直接测试 helper 与单独创建的真实 manager。测试设计有价值，但没有覆盖上述差异，也没有 L02 消费。实现者报告的 3/5 passed 和全 lane 294+1skip 未作为独立运行证据。

处理结果：只勾选“候选提供面静态事实”子项，L01-01/03 父项仍未勾选；L01-02 系统 OCR 继续阻塞，L01-04 已关闭且本轮未重跑。L02/L07 报告与编号本轮未改。未因未集成候选而在旧代码上运行 suite，本轮据此结束。

## 第三次定向续审：L07 完整候选 7455ad39f

祖先检查 exit 1，本轮只读候选 Git 对象，无 merge/cherry-pick、实现编辑或候选测试执行。已读取 main 的 quality §10 与 decisions D1～D6；不将“内部拒绝大整数”作为 D3 精确性的替代。

| 编号 | 实际修复提交 | 静态结论与生产入口（候选行号） | 未决 |
|---|---|---|---|
| L07-01 | `d5912d52f`、`4b61b9d7b` | `index.ts:222-231` 真实实例化/注册 PtcToolExecutor；`src/tools/ptc-tool-executor.ts:50-83,103-125` 委托 admitted dispatcher 并清除继承审批 | 候选 L04/L03 尚未消费 toolExecutors；新增测试的 dispatcher 是外部 seam，不能据此关闭实际中央调度集成 |
| L07-02 | `d5912d52f` | `src/skill-package.ts:704-705,804-813`、`src/skill-taps.ts:395-440`、`src/skill-market.ts:959-1015`、`src/skill-updates.ts:335-390` 的 dispose/finally 覆盖所报提前退出 | 静态修复确认，runner 待集成 |
| L07-03 | `d5912d52f` | `src/skill-market.ts:980` 改平台 now().rfc3339，与 Rust provenance 格式一致 | 静态修复确认，未运行格式回归；不据单个 +00:00 断言证明纳秒保真 |
| L07-04 | `d5912d52f` | `index.ts:207` 注入 logger；`src/files.ts:160,178` 补两个原 warn 分支 | 静态修复确认，runner 待集成 |
| L07-05 | worker 主体 `d5912d52f`；`4f28d58d8` 仅 API/导出测试 | catalog/repack/export/scan 实际走 `src/workers/zip-pool.ts` 与 zip-worker | market handoff `src/skill-market.ts:746`、来源更新 `src/skill-updates.ts:148` 仍同步重打包；worker 故障被映为 INVALID_INPUT，丢 Rust 的 IoError/join 上下文；utilityProcess/三平台未验证 |
| L07-06 | `d5912d52f` | `src/skill-package.ts:836-864` 恢复 open/read 阶段错误和 MAX+1 有界读取，finally 关闭 fd | 静态修复确认；未见新增本地故障/增长越界测试，runner 待集成 |
| L07-07 | `d5912d52f` | `src/skill-market.ts:64-99` 一次 signal 跨 redirect/body；新测试保留真实 transport 并检查复用/abort | 静态修复确认；真实 HTTP 慢 redirect/body 与 runner 未验证，不外推全部 reqwest 行为 |

本节路径相对 `host/plugins/agent-skills/`，均为候选 `7455ad39f`。测试代码归属另有 `3a58d7aec`；`7455ad39f` 仅为最终 LANE 报告。`tests/ptc-production-wiring.test.ts:78-124` 是真实插件→公开执行器→真实脚本，但 `:37-49` 为自建 dispatcher；它不是本 lane 主体替身，却也不证明 L04 准入实现已接线。必须保持这一区分。

候选中复核确认 C1 已派回的 bigint 回归：`repository/connector-ledger.ts:129-145` 拒绝合法的 `9007199254740992n`，而 Rust `src-tauri/crates/dstu-agent/src/chat_v2/connector_ledger.rs:140,175` 接受 i64。新非法 TEXT 测试不能替代合法大整数断言。D3 要求内部精确并在 IPC 边界遵循原数值行为；此项继续沿用 C1 派单，不能签成“无损修复”。

本轮 runner：**未运行；退出码不适用；无 Errors 行可供独立引用**。未复用提供方“31 文件 417 passed”作为独立结果。待候选集成，限定运行 ptc-production-wiring 新用例、prepared dispose、market 安装时间/失败清理/deadline、files warn、tap worker export 的新增单元（完整命令列于 L07 ACCEPTANCE §6），不重跑三 lane 全量。不把 Linux worker 结果当 Electron utilityProcess、打包或三平台验证。

结果：只勾选已核实的候选静态子项；原七个父项仍未勾选。L07-01 的“仅收集器”旧描述仅属于初审基线，候选提供方已实际改善；L07-05 尚有明确代码遗漏，另有 C1-D3 候选回归。L01/L02 本轮不重复复核，B 结论不变。

## 第四次增量续审：D3 与 L01-03.a～e

| 子项 | 候选/实际提交 | 独立静态结论 | runner/job |
|---|---|---|---|
| L07 C1-D3 | `111fab06a`；代码 `7b04e407f`、`26c15aef6`，测试调整 `8365744b5` | 完整 i64 bigint 读写、四查询 safeIntegers、BigInt 过期比较及仅工具 JSON 边界 Number 已核对。旧 `7455ad39f` 的拒绝合法 bigint 缺陷不再对该候选成立；真实数据库往返 2^53+1/i64::MAX 的新测试断言有效 | 未入 main；未运行、无 job id，退出码/Errors 不适用 |
| L01-03.a/c/d/e | `c7fe0a752`；主体 `c12ca3e95`、测试 `e3ce631da`、API `52ed4e8cd`；`396e3ea11` 仅报告 | 显式/权威协议优先、每POST timeout、header warn/Configuration、非流式真实 bridge 与独立 stream API 已静态确认。新增用例确实经过 ctx 服务与同一 manager | 未入 main；未运行、无 job id，退出码/Errors 不适用 |
| L01-03.b | 同上 | 有界净化和404→429已接；**尚有03.b.1错误码回退顺序差异**：一级 code 空字符串时，Rust 走 HTTP/全文 fallback，候选继续取顶层 code | 静态反例见 L01 ACCEPTANCE §7；无动态复现声明 |

D3证据：`111fab06a:host/plugins/agent-skills/repository/connector-ledger.ts:140-158,205-255`；平台 `host/platform/storage/connection.ts:128` 确实应用 safeIntegers；工具 `src/tools/connector-executor.ts:499-508,796,827` 比较与JSON边界分开。测试 `tests/connector-executor.test.ts:213-288` 保留旧过期向量并新增真实库往返/边界输出。原七编号不因该局部修复关闭，尤其 L07-05 仍在队列；本轮不重审它们。

L01真实提供入口：`c7fe0a752:host/plugins/llm-providers/index.ts:82-89` → prepare/stream/nonstream；`api.ts:211-223` 不再混淆两种 send。新测试 `tests/codex-auth-service.test.ts:235-460` 经 ctx 服务验证协议/headers/错误归一化/独立超时/SSE桥接。03.b.1：候选 `src/openai-codex/response.ts:110-120` 对 `{"error":{"code":""},"code":"other"}` status400 得 `other`，Rust `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4628-4652` 得 `http_400`；应保持原先取第一个字符串再净化的顺序。

两次 `git merge-base --is-ancestor <候选> main` 均 exit 1。没有摘实现、没有旧源码重跑，没有把提供方16定向/302+1skip等结果当独立证据。以后重检查全部用 `node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- <命令>`，集成后仅跑各报告 §7 指定单文件/测试名；提交后继续轻量审读，再取 result，记录作业号与原退出码/Errors。本轮无需提交无法覆盖候选的作业。

L02实际消费、L01系统OCR及其他未决项未因提供方局部修复关闭；三个 lane 仍不授予 B。历史段落中的旧候选缺陷需与本节版本限定共同阅读。

## 第五次续审：L01 已集成后的 jobs 最小动态验证

`699e04283` 合入 main 快照 `97ffb137a`（通知中的 f62b50fe1 后主线继续前进）；52ed4e8cd、396e3ea11 均为 HEAD 祖先（exit 0）。对 c7fe0a752 的 L01 实现/测试 diff 为零，仅验收文档变化，沿用已完成静态审读。合并冲突保留独立结论，main 的实现者附录注明其自述身份。

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/llm-providers/tests/remote-image.test.ts host/plugins/llm-providers/tests/codex-auth-service.test.ts --maxWorkers=1
作业号 20261104062852-4bb63e
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104062852-4bb63e
 ✓ host/plugins/llm-providers/tests/remote-image.test.ts (3 tests) 2105ms
 ✓ host/plugins/llm-providers/tests/codex-auth-service.test.ts (13 tests) 5567ms
 Test Files  2 passed (2)
      Tests  16 passed (16)
   Duration  11.12s
[作业 20261104062852-4bb63e] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104062852-4bb63e.log
```

result调用exit 0，作业原exit 0；完整输出无Errors行/未处理错误。提交后做轻量基线核对，未直接运行vitest、未重复提交。此结果现为独立动态证据，不再仅是提供方报告。

| 验收项 | 动态结论 | 父项状态 |
|---|---|---|
| L01-01 提供方预取/缓存 | 3条真实本地HTTP及同步内联测试通过 | L02实际预取消费仍未闭合，父项不勾选 |
| L01-03 提供方共享认证/prepare/send | 13条通过，含ctx服务协议/header/错误主路径/独立超时/非流式桥接 | 03.b.1一级空code回退仍有差异，L02消费仍待；父项不勾选 |
| L01-02/04 | 不在本轮最小集 | OCR继续阻塞，04保持已关闭不重跑 |

未重复静态审、全lane/三lane suite或跨平台测试；未执行Rust。详细原始摘要及勾选范围见 L01 ACCEPTANCE §8。L02/L07本轮不重复验收，三个lane仍未获B。

## 第六次增量：03.b.1与L07-05/06候选

| 编号 | 候选/提交 | 静态结论 | 独立动态状态 |
|---|---|---|---|
| L01-03.b.1 | `ae76da7d3` / `49cf21dc8` | 已改为取首个字符串再sanitize，空/非法值不再取次级code；新增3反例经真实ctx服务和HTTP返回http_400 | ancestor exit1；未入main，无job/runner |
| L07-05 | `db5bfe8f5` / `1aff05ac5` | market/update均await worker；基础设施错误有专门类型，调用者恢复IO_ERROR任务上下文，业务无效ZIP仍原分类 | ancestor exit1；未入main，无job/runner；utilityProcess/三平台仍未验 |
| L07-06 | `db5bfe8f5` / `1aff05ac5/60fc55f8e` | 实现保留MAX+1及open/read分段，新增本地阶段故障/持续增长测试真实调用生产方法 | 新测试在不适用平台直接return会伪记passed；增长测试未断言累计MAX+1，需收紧证据；无独立runner |

L01证据：候选 `host/plugins/llm-providers/src/openai-codex/response.ts:107-125` 对照Rust `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4628-4652`；新公开服务向量在 `tests/codex-auth-service.test.ts:352-378`。此前03.b.1代码问题在新候选静态已修；C1的`20261104064008-263218`（14passed/exit0）只是协调者报告，未继承为R1实跑。集成后只跑该新增测试名，不重复已独立通过16条。

L07证据：候选 `host/plugins/agent-skills/src/skill-market.ts:747`、`src/skill-updates.ts:156`、`src/workers/zip-pool.ts:32-46,88-147,164-166`；Rust market `:583-588`、updates `:170-174` 和 tap/skills的join-vs业务分类均已对照。原两个遗漏及扁平化缺陷不再对新候选成立。新增pool测试真实触发postMessage DataCloneError/无效ZIP，业务测试仅替换下载seam。

新测试未决：`tests/skill-package.test.ts:381,396` 运行时return应改可见平台skip；`tests/skill-package-local-read.test.ts:13-25,48-59` 应记录请求长度累计并断言MAX+1，当前“有增长超限错误且calls>1”不能钉死读取精确边界。不擅改Rust不变量，不将平台跑不了算passed。

C1报告的tsc `20261104064149-3db956`、local-read `20261104064139-aa41c2` exit0未作为独立证据。本轮**无作业号、runner原退出码/Errors不适用**；未摘实现或在旧源码重复suite。集成后单文件/新增名称的jobs命令已列L01 ACCEPTANCE §9、L07 §8。L02消费/OCR及L07其他待验边界不随此增量关闭，整lane仍不授B。

## 第七次增量：仅 L07-06 的 b34d4cbaa 后继测试修复

`git merge-base --is-ancestor b34d4cbaa main` exit1；只读db5bfe8f5→b34d4cbaa差异。生产读取实现无变化，不重做05/D3或其他已确认静态修复。

| 已派问题 | 后继证据（路径相对host/plugins/agent-skills，固定b34d4cbaa） | 更新结论 |
|---|---|---|
| 不适用平台静默return伪计passed | `tests/skill-package.test.ts:380-415` 两处改it.skipIf，写明Windows/root权限与非Linux /proc夹具原因，保留阶段错误断言 | 静态确认已修；不再派回 |
| 增长用例未精确钉死MAX+1 | `tests/skill-package-local-read.test.ts:27-36,74-93`记录实际生产readSync请求长度/返回量，累计两者MAX+1、末次1byte、readAfterLimit=false，错误返回后microtask调用数不变 | 静态确认已修；不再派回 |

增长测试替换的是外部readSync seam，调用真实readZipBytes，不是测试重写读取算法；Rust依据为`src-tauri/crates/dstu-agent/src/chat_v2/skills.rs:2401-2410`。当前循环同步，失败后microtask检查仅按该生产模型理解，不扩称任意异步系统已验证。

C1报告`073038-f5442f` Linux36pass/0skip、`073038-9acac1` 1pass均exit0；本轮不冒充亲跑/亲取。**独立job id、runner退出码、Errors均不适用**。候选未集成，06父项保持独立运行待验；集成后仅用jobs运行`read_zip_reports_local|stops_at_limit_plus_one`，命令见L07 ACCEPTANCE §9。没有发现此次两个指定修复的额外静态残差，utilityProcess/三平台仍未验证，B结论不变。

## 第八次：L02-01/03/08候选限量复核（含中断恢复）

固定L02 `99d95149a`、L16 `18c563a46`。两者对main ancestor检查exit1；提供方路由提交`0982ae65c`本身已在main（exit0），但L16消费完整树尚未集成。只读候选，无摘实现/新suite；详细TS/Rust文件:行和测试证据界限在L02 ACCEPTANCE §6。

| 编号 | 已修hash → 真实生产入口 | 更新判断/队列 |
|---|---|---|
| L02-01 | `65c796fab`状态注入；`51639c462`连接/stream；`d9823d11d`raw；`cafa8660a`essay/RAG。候选index:89把ctx.llmCodexAuth.status传store；:92/316/350接真实共享prepare/send | 不再有旧snake_case存储副本判断；连接/single-shot/raw主路径不再固定拒绝。仍需L02修provider_requests_service:16、ocr_hedge_service:94的同步plain调用；不去掉plain helper原有OAuth拒绝不变量 |
| L02-03 | `d9823d11d`，index:329-351→completion:30-40共享reasoning/generation→:70-81真实L01 adapter/Codex→:98响应归一 | 旧手写provider替代已修。completion:94-101失败及成功无usage调用，runtime只含adapters/codex；F3公开collector接缝+L02记录仍待。Rust pipeline:9235-9270,9305-9338有对应记录 |
| L02-08 | `0982ae65c` index:98→anki_routing_service:13-28；L16 `374914c1d`，18c563a46树的plugin-handlers-generation:54-62→generation-service:396-413/1008-1012 | 提供与generator/critic真实消费代码均已存在，不再派回“API未提供/只有纯函数”。候选组合未main、独立动态未验；不外推全部制卡/critic模型调用等价 |

L02新集成测试真实安装L01+L02并使用本地OAuth/Responses HTTP，覆盖共享状态、刷新/连接/流式和logout；boundary/RAG配置选择仍用spy，不证明完整配置链。路由提供测试用配置seam、L16消费测试用路由seam，两者都调用真实各自业务，但不能相加声称真实两插件组合已经跑通。均仅静态审读，候选无独立job/runner退出码/Errors。

**C1抄送/原owner剩余队列**：01同步Model2/OCR共享auth；03成功/失败usage的F3公开接口及L02消费；原远程图片消费（候选L02没有prepareRemoteImages调用）；08待L16集成/限定验证。旧问题已修部分不再派回。未扩大到05/D3/L01-03.b.1，也不让实现者ACCEPTANCE覆盖独立报告。其余02/04/05/06/07保持原owner派工：已见token修复`44c4e7468`，候选index:258-259真实调nativeTokenizer，但本轮不扩审其全套数值向量，父项不擅勾。

恢复核对：首次`git log --oneline -20`、`git status`显示此前提交都在且工作区干净；再次恢复时L02报告已由`b0f815cca`保存，仅本汇总待提交。工作树TESTMAP为旧合入基线662/5，候选自述664/3，仅作快照区别。按恢复要求经全局jobs提交只读ledger作业`20261104085104-05708d`，检查对象为review基线，不是候选实现；恢复后复用该作业取result，没有重复提交。

```text
$ node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104085104-05708d
> deep-student@0.11.0 migration:ledger
> node scripts/electron-migration/ledger.mjs --check --no-write
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 77% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104085104-05708d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104085104-05708d.log
```

result命令和作业原退出码均0；输出无Errors行。该只读账本通过只说明当前归档机械检查未发现问题，不能覆盖pending、空SPEC或独立审读未决项，也不是L02/L16候选的vitest实跑。原父项01/03/08保持待集成/剩余入口验证，已修API/消费事实已更新，不继续沿用旧缺失描述。

---

## R1自有三份验收原文归档

以下为固定review `352e712376661b0e15df76f918653389a791c55a` 中三份文件的完整原文；来源/归属核对见本文开头“集成兼容归档”。围栏内保留发现时行号和结论，不因搬迁重新解释历史测试结果。

<a id="r1-integration-acceptance"></a>
### 原文件：host/plugins/integration/ACCEPTANCE.md

<!-- BEGIN R1 ARCHIVE: host/plugins/integration/ACCEPTANCE.md -->
````markdown
# L22-app-commands / integration 独立验收（R1-review-llm，2026-11-04，standard-v2）

结论：不通过（原测试/跨lane证据未闭合；不代表本插件已发现新的业务命令实现错误）

**main复验签收更新（`b70b5e238`，当前`ddb6550bd`相关代码无差异）**：3c76312fd与bf3848a66均已集成，独立作业`20261104131022-87fc5b`实际执行llm-codex-connection.test.ts两条并通过。签收四条原Codex判定断言及准确表头子项；29pending继续保留。该作业整体exit1（唯一tokens_command缺tiktoken），不将两条通过改写成整作业通过。下段“仅候选”为历史阶段。

**后继候选静态记录（review `2f83023df`）**：`3c76312fd`的llm-codex-connection.test.ts真实安装L01+L02，经test_api_connection和本地HTTP观察四种持久化/请求认证优先级，保留Rust commands.rs:5912-5916、5924-5928、5933-5937、5938-5942四条原断言。`bf3848a66`仅更正表头157ported/29pending/4merged/53obsolete；两者当前均非HEAD祖先，未执行候选或继承提供方2pass。main集成后仅跑该单文件，IN-01其余pending仍保留。`3b657447c`的Promise文档纠正已进入当前main，下文该建议为历史问题，不要求新增锁机制。

基线main `eeaf5bdc7` / review merge `21cc05604`。本插件`index.ts:4-14`实际**0条命令**，唯一provide是appCommandState；contracts/ipc也没有L22-app-commands.json实体（旧SPEC引用的路径不成立）。不能凭“每插件≥15命令”要求虚构15条本插件IPC。以下全查其生产服务，并对15条跨插件命令入口/错误探针建立证据矩阵，明确外部owner与独立证据来源；不重跑X1已完成的全profile错误探针。

E1=Rust/TS动态差分（本轮无）；E2=本轮生产入口测试；E3=Rust源码审读；X1=引用其他独立验收人的原始现场，不计作R1实跑或完整命令等价。

## 必须修复

- [ ] **R1-IN-01（P1验收缺口）：表头和Codex两条已签收，29pending仍未闭合。** `bf3848a66`修正TESTMAP:12，当前逐行统计与表头一致：157ported/29pending/4merged/53obsolete。`3c76312fd`的:44-45两条已在独立门禁中实际通过，保留Rust commands.rs:5912-5942四种认证优先级；不沿用旧“L01认证未发布”阻塞。generative UI等剩余pending仍需各owner真实提供面/生产证据，不强迫L22复制其他lane实现，不因两条Codex绿灯关闭整个缺口。

## 建议

- `SPEC.md:91`声称Promise回调会抛错、类型签名禁止async，实际`api.ts:47`泛型R可为Promise，`src/app-state.ts:44-50`没有该检查。这是文档/公开边界声明不准确；当前未发现生产异步消费，不作为已发生并发损坏的finding。不要新增凭空锁框架，先纠正证据声明。
- merged/obsolete应逐项引用审批，不把ledger机械通过当成协调者批准全部语义删除。4项移动专属已在`migration/approvals.json`登记；delta批次审批参考C2分片和OBSOLETE-REQUEST-delta.md；未在本轮重做已由C2/R4核过的死代码证明。

## 已核实通过

- [x] appCommandState真实provide与版本命名一致：`index.ts:9,13`、`api.ts:51`、`src/app-state.ts:40-42`。不是只导出类。
- [x] cap=8，按chrono纳秒再UTF-8 id顺序驱逐；`src/app-state.ts:13-33` ↔ `src-tauri/src/commands.rs:181-200`。只删Map，不写持久表，不制造另一份数据库实例。
- [x] 6条app-state测试通过真实Host服务，含纳秒和卸载；13条probe纯函数测试调用L02真实生产实现，不是测试复制算法。19条定向实跑exit0，结果见下。
- [x] activeDatabase有实际消费：`host/platform/storage/index.ts:179,201-225,248`读取该服务选择槽。平台分层与注入改造由F3/C2所有；本报告不把旧SPEC:96“没有消费”继续当当前事实。

## 生产服务与15条跨插件入口交叉审读

服务本体：`src/app-state.ts:44-50`同步回调后驱逐，对应Rust cache_temp_session持锁内insert+evict（commands.rs:202-207），持久化仍属于别的入口；当前未找到生产调用withTempSessions，不能把服务单测等同完整临时会话缓存/落盘链已接。

以下矩阵只覆盖所列**错误分支/注册包装**，不是15条命令全分支验收。Rust前缀`src-tauri/`；B=host/plugins/backup，S=host/plugins/sync-providers。证据来自本轮读命令包装与契约，以及`ds-mig/X1-e2e-smoke:docs/dev/electron-migration/audits/X1-e2e-smoke.md` §0.4固定main `3b2758d7a`的真实Host探针。C2协调日志`docs/dev/electron-migration/coordination/C2-platform.md:48,77-93,110`给出原派工；其旧panic数字不作为新基线事实。

| # | 外部命令 | Rust入口 | 当前TS入口/限定结论 |
|---|---|---|---|
|1|data_governance_auto_verify_latest_backup|src/data_governance/commands_backup.rs:1494|B/index.ts:246→backupCommands；无备份返回string业务错，X1已测settle，不重派panic|
|2|data_governance_check_disk_space_for_restore|commands_backup.rs:1320|B/index:243；空backupId校验，X1已测string错误|
|3|data_governance_cleanup_audit_logs|src/data_governance/commands.rs:598|B/index:227-231；令牌格式错由wrap映射，X1已测|
|4|data_governance_delete_backup|commands_backup.rs:1271|B/index:242；空id，不触发删除，X1已测|
|5|data_governance_export_zip|src/data_governance/commands_zip.rs:698|B/index命令声明:143及zipCommands wrap注册；空id，X1已测|
|6|data_governance_get_database_status|src/data_governance/commands.rs:1005|B/index:235；未知库错误string，X1已测|
|7|data_governance_import_zip|commands_zip.rs:1209|B/index命令声明:148及zipCommands wrap注册；空path返回不存在错误，X1已测|
|8|data_governance_restore_backup|src/data_governance/commands_restore.rs:420|B/index命令声明:150及restoreCommands wrap；空id，X1已测；不扩大为恢复数据安全通过|
|9|data_governance_resume_backup_job|commands_backup.rs:2395|B/index命令声明:151及zipCommands wrap；不存在job，X1已测|
|10|data_governance_verify_backup|commands_backup.rs:1403|B/index:244；空id，X1已测|
|11|data_governance_verify_backup_with_assets|src/data_governance/commands_asset.rs:138|B/index:245；空id，X1已测|
|12|cloud_storage_check_connection|crates/dstu-sync/src/cloud_storage/mod.rs:297|S/index:40-55声明、createStorage:61-69校验；空WebDAV config Validation，X1已测|
|13|cloud_storage_delete|cloud_storage/mod.rs:346|同S包装；配置失败先于外部删除，X1已测|
|14|cloud_storage_exists|cloud_storage/mod.rs:370|同S包装；配置失败为AppError，X1已测|
|15|cloud_storage_get|cloud_storage/mod.rs:322|同S包装；配置失败为AppError，X1已测|

B的`stringErrorCommand:120-130`显式保持String契约；S的`createStorage:61-62`映射配置错误，两者不可统一改成一种错误。此处没有跨owner修改代码。X1现场Node/Electron各21条合法业务错、0命令panic，但整个作业仍exit1（memory启动降级），不能把“子命令通过”写成整机绿色。SSE探针在X1§0.3也只证明快速失败settle，不重复宣称网络成功或GUI/MessagePort验证。

## TESTMAP真实性抽查（17条）

`R=src-tauri/src/commands.rs`；P=本插件tests/llm-probe-helpers.test.ts，A=tests/app-state.test.ts。P中测试直接调L02已注册test_api_connection/fetch_vendor_models所用函数（P:4-6），属于真实纯函数路径，不是本插件拥有这些命令。A走本插件公开service。

| 测试 | R行 | TS行 | 结论 |
|---|---:|---|---|
|ollama_root_base_url_lists_models_under_v1|5346|P36|通过4个端点形状|
|chat_probe_body_uses_completion_tokens_for_reasoning_models|5528|P48|通过32/无max_tokens/stream/无temperature|
|chat_probe_body_keeps_max_tokens_for_plain_models|5548|P80|通过3断言|
|chat_probe_body_disables_thinking_for_qwen_reasoning|5563|P59|通过关闭thinking+token字段|
|chat_probe_body_respects_mimo_dialect|5583|P70|通过disabled对象/32/无旧字段|
|probe_u32_field_reads_common_provider_shapes|5666|P90|通过7种字段/值|
|inspect_probe_buffer_judges_sse_events|5717|P102|通过delta/created/DONE/error/keepalive/partial/EOF|
|inspect_probe_buffer_judges_non_sse_responses|5774|P129|通过JSON成功/错误/HTML|
|test_model_kind_prefers_flags_then_heuristics|5795|P145|通过5种分类|
|asr_models_route_to_asr_probe|5832|P154|通过8模型向量|
|chat_models_do_not_route_to_asr_probe|5856|P169|通过6模型排除|
|asr_heuristic_excludes_tts_and_speech_synthesis|5878|P182|通过4种TTS排除|
|build_asr_probe_wav_is_valid_mono_16k|5893|P193|通过RIFF/WAVE/data/32000/总长|
|under_cap_is_noop|5979|A34|通过cap边界不删；精确数组断言覆盖Rust长度不变量|
|evicts_oldest_by_created_at|5995|A40|通过最旧删除/最新保留/cap|
|evicts_multiple_when_far_over_cap|6011|A46|通过删最旧3个/cap|
|equal_timestamps_fall_back_to_lexicographic_id|6029|A52|通过同刻id顺序|

有些Rust `assert is_ok + unwrap`在TS为成功调用+值断言，并非将错误变成功的弱化；本表按行为对应，不仅按expect文本计数。另核`tests/tools-registry.test.ts:101-110`对`src-tauri/tests/mod.rs:14-30`原本就只验证构造/错误码，未将它误读为所有工具功能E2E。

未对155ported全量逐条授予通过；31pending和4merged/53obsolete需与当前审批、owner证据闭环，尤其不沿用旧头部统计。无本插件业务写表，无生产console、测试替身导入或跨插件实现导入（测试的跨owner内部引用有现有boundary理由，不等同生产依赖）。

## 独立运行摘要与证据边界

```text
job 20261104110558-baedf5
npx vitest run -c vitest.host.config.ts host/plugins/integration/tests/app-state.test.ts host/plugins/integration/tests/llm-probe-helpers.test.ts --maxWorkers=1
Test Files 2 passed (2)
Tests 19 passed (19)
Duration 5.56s
[作业 20261104110558-baedf5] 退出码 0
```

result完整输出无Errors；日志`/home/dsdev/.oc-jobs/done/20261104110558-baedf5.log`。没有重跑X1/C2的21错误命令或整机启动，没有Rust编译/运行。X1引用为其分支报告，不当成main已存在的文件或R1实跑；其不同基线的startup不足照原文保留。R1-IN-01为L22证据闭合项，不把其他owner既有finding重复命名派回。

## Codex与表头子项main签收

独立官方门禁子作业`20261104131022-87fc5b`在review b70b5e238执行；完整日志:464-466显示llm-codex-connection.test.ts **2passed**，两条测试均列出通过。原job为六目录强制门禁，整体**exit1，2273passed/1failed/3skipped**；唯一失败是L02 tokens_command缺F7正式tiktoken依赖，两条Codex没有skip/失败。复用已有原始证据，不重复提交整目录或单文件。

`tests/llm-codex-connection.test.ts:106-142`安装真实L01+L02并invoke test_api_connection，通过本地HTTP路径与Authorization观察：持久化OAuth优先、持久化API-key优先、未保存配置显式OAuth、未保存且无auth_mode。对应Rust `src-tauri/src/commands.rs:5912-5916,5924-5928,5933-5937,5938-5942`四条断言；原谓词私有不妨碍通过生产命令验证。文件与已审候选3c76312fd无差异。

bf3848a66仅表头修复；本轮只读逐行计数得到157/29/4/53，与当前头部一致，未跑ledger或编辑TESTMAP。SPEC Promise声明修正3b657447c沿用已确认结论。IN-01仅这两个子项关闭，剩余pending/审批/平台范围仍按原owner追踪。
````
<!-- END R1 ARCHIVE: host/plugins/integration/ACCEPTANCE.md -->

<a id="r1-media-acceptance"></a>
### 原文件：host/plugins/media/ACCEPTANCE.md

<!-- BEGIN R1 ARCHIVE: host/plugins/media/ACCEPTANCE.md -->
````markdown
# L18-media-docs 独立验收（R1-review-llm，2026-11-04，standard-v2）

结论：不通过

**最新复验**：main 修复 `a34d959a6` 已集成至 review `0ca6ebaa5`，当前 `2f83023df` 对相关实现/测试无差异。独立门禁作业 `20261104120904-53776d` 已实际执行下述入口向量，MD-02/03签收；其余四项保持未决。详见末节，前文旧行号/问题描述为发现时基线。

基线 main `eeaf5bdc7` / review merge `21cc05604`。E2=生产入口测试，E3=逐分支源码对照；没有运行Rust，不声称E1差分、utilityProcess或三平台通过。只写验收文件。下文TS短路径相对`host/plugins/media/`。

## 必须修复

- [ ] **R1-MD-01（P1，E3）：字幕导入/教材重链接越权写files。** `repository/media-commands.ts:41-42`、`repository/textbook-files.ts:24`直接UPDATE L11所有的files；`src/media-commands.ts:183`在真实导入中调用前者，index的textbooks_relink调用后者。文件头“Writes stay in L11 services”不符合代码。按v2§1.2和D1/D4经L11公开业务/WithConn接缝写投影，不能为此拆散原事务或取消副作用。Rust对照`src-tauri/crates/dstu-media/src/media/commands.rs:418`→pipeline.write_transcript_text及`src-tauri/src/cmd/textbooks.rs:700`的文件修复流程。
- [x] **R1-MD-02（P1，E3+入口测试）：media_transcript_get运行状态修复已签收。** `a34d959a6`的`index.ts:396-398`读取真实pdf.isRunning后传入buildTranscriptView，对照Rust `src-tauri/crates/dstu-media/src/media/commands.rs:383-394`。原硬编码false已移除；独立作业`20261104120904-53776d`实际执行kernel入口的queued/running/none三分支断言通过，详见末节。
- [x] **R1-MD-03（P1，E3+入口测试）：读失败前取消ASR的顺序修复已签收。** `a34d959a6`的`index.ts:428-432`先读成功再取消，对照Rust commands.rs:432-437、450-455。独立作业`20261104120904-53776d`实际执行不存在字幕输入：io-failed、cancel未调用、运行状态保留三断言通过。同步/有界读本身仍归MD-05。
- [ ] **R1-MD-04（P1，E3）：公开docs服务是部分格式实现，相似算法被当等价。** `src/service.ts:130-142`提供真实docs方法，但`src/document-parser.ts:718-731,739-762`将有效DOCX/Excel/PDF等变Unsupported；Rust `src-tauri/crates/dstu-docs/src/document_parser.rs:887-899`分发真实解析。EPUB `htmlToText:280-283`明确省略Rust `html2text::from_read(_,80)`的折行/库行为（Rust:3823）；不得以“不是wire”绕过内容等价。相关parse_document_from_path/base64命令也未注册（index meta:138-163）。把未完成能力/替代差异交owner与F7闭合，不把仅错误前置路径成功称完整解析器。
- [ ] **R1-MD-05（P1，E3）：大文件同步I/O/解析阻塞且有界读丢失。** `index.ts:117-131`stat后readFileSync全量读取，`src/service.ts:131-136`先全读再检查大小，EPUB解压/文本解析在Host同步执行；Rust字幕入口使用bounded reader（commands.rs:433-435）且解析/导出在spawn_blocking（:459-461,:518-520）。v2§1.7要求worker处理大文件/CPU；保留原MAX+1及阶段错误，不只在读后检测大小。导出index:398同样是同步整写。需真实worker/平台文件能力，不能以async方法声明掩盖同步工作。
- [ ] **R1-MD-06（P2，E3）：OCR策略/测试账本仍有重复实现及未闭合项。** `src/ocr-settings.ts:78-316,408-445`复制L01 OCR工厂/提示及L02迁移策略，而非对方api；清理/迁移业务info（Rust `src-tauri/src/cmd/ocr.rs:170-173,217-240`）未记录。实际TESTMAP231ported/12pending，表头仍77/166；`test_bounded_xlsx_writer_rejects_growth_past_limit`标ported（TESTMAP:37），但BoundedCursor仅定义/测试、实际XLSX writer未接（document-parser.ts:126-144,747）。需真实生产路径与准确统计，不以同文件可达消除这些问题。

## 建议

OCR配置序列化错误当前使用自写中文字段错误/V8 JSON错误（ocr-settings:330-368），与serde精确文案仍需owner完整核对；本次不把这类风险描述成未运行的已复现失败。应复用已有OCR公共策略以避免双实现继续漂移。

## 已核实通过

- [x] 定向73测试exit0，无Errors行；OCR管理、字幕导入/导出、progress等实际通过kernel invoke；仓储依赖由测试提供真实L11类，不能等同完整生产profile。
- [x] OCR输入校验先读/解码当前列表，再系统保护/重复校验，priority重排、显式enabled默认值、recommendedModel null形状在抽样内对应Rust。
- [x] HEIC桌面unsupported由nativeHeic保留（index:272-291），不要求按D5引入libheif“补功能”；本轮未执行HEIC测试或签跨平台。

## 命令审读（18条）

`O=src-tauri/src/cmd/ocr.rs`，`M=src-tauri/crates/dstu-media/src/media/commands.rs`。契约`contracts/ipc/L18-media-docs.json`，TS入口index.ts。通过只覆盖所列分支，依赖共同finding的整命令不签全等。

| # | 命令 | 结论与TS/Rust定位 |
|---|---|---|
|1|get_ocr_engine_type|通过：缺省paddle_ocr_vl/Database前缀；index:189-191 ↔ O:57-66|
|2|set_ocr_engine_type|校验/规范化通过；index:216-218、ocr-settings:630-637 ↔ O:89-102；策略重复见MD-06|
|3|get_ocr_thinking_enabled|通过读失败false/true匹配；index:208、ocr-settings:641-646 ↔ O:71-72→LLMManager.is_ocr_thinking_enabled|
|4|set_ocr_thinking_enabled|通过：true/false字符串写setting，写错Database；index:193-196 ↔ O:77-84|
|5|get_ocr_engines|输出6字段/平台分支抽查通过；index:209、ocr-settings:649-665 ↔ O:39-52；工厂重复MD-06|
|6|get_ocr_prompt_template|unknown回默认/模式解析通过；index:210-211、ocr-settings:669-671 ↔ O:138-147；必须消除复制策略|
|7|infer_ocr_engine_from_model|入口/字符串输出通过；index:212-213、ocr-settings:675-676 ↔ O:107-109|
|8|validate_ocr_model|通过：无效才recommendedModel，合法显式null；index:214-215、ocr-settings:680-688 ↔ O:114-125|
|9|get_available_ocr_models|主迁移/孤儿清理/读取失败跳过清理顺序通过，日志/重复策略MD-06；index:236-240、ocr-settings:473-548 ↔ O:155-244|
|10|save_available_ocr_models|通过：enabled缺省true、priority缺省数组位置、先serialize后save；index:198-206 ↔ O:357-398|
|11|update_ocr_engine_priority|通过：只更新存在id、按priority稳定排序；index:224-227、ocr-settings:613-626 ↔ O:404-435|
|12|add_ocr_engine|通过所查顺序：读取→系统保留→重复→推断→尽力供应商停服检查；index:229-234、ocr-settings:552-596 ↔ O:448-523|
|13|remove_ocr_engine|通过：系统保护、missing错误、删除后重排；index:220-222、ocr-settings:600-609 ↔ O:528-563|
|14|media_progress_get|通过：先文件解析后owner repo，缺值null；index:361-368、media-commands:187-195 ↔ M:534-541；大整数完整边界不在本轮已验证范围|
|15|media_progress_set|通过所查参数透传/owner调用；index:369-380、media-commands:197-204 ↔ M:545-566；非声称整个仓储算法复验|
|16|media_transcript_get|问题MD-02；index:382-388固定false ↔ M:383-394真实running|
|17|media_transcript_import|问题MD-01/03/05；index:411-429、media-commands:157-184 ↔ M:423-478。成功后日志/索引调度存在，不能抵消错误前取消顺序|
|18|media_transcript_export|无完成段错误/格式/计数通过，同步I/O见MD-05；index:391-409、media-commands:132-153 ↔ M:505-530|

运行命令错误没有被笼统归为“裸Error”：index:98-104有MediaError包装，但其他库异常是否全覆盖仍需各owner分支审读。X1旧paths缺注入问题不重复派：当前index:165已inject paths。

## TESTMAP真实性抽查（17条）

`R=src-tauri/crates/dstu-docs/src/document_parser.rs`；`T=tests/document-parser.test.ts`。docs服务经index:168→service.ts:125-154触达实际parser；单测直接调生产实现，属于E3原断言对照加TS执行，不标成kernel整命令E2。

| 测试名 | R行 | T行 | 结论 |
|---|---:|---:|---|
|test_document_parser_creation|4181|23|通过构造无状态目的（Rust ZST/TS Object.keys）；不证明格式能力|
|test_txt_support|4187|29|通过正常返回/内容（成功调用等价Rust is_ok+unwrap）|
|test_txt_with_unicode|4196|35|通过中文/英文内容|
|test_md_support|4205|41|通过Markdown原样|
|test_txt_gbk_decoding|4229|47|通过精确文本/无U+FFFD|
|test_txt_utf8_bom_decoding|4242|57|通过去BOM|
|test_markdown_extension_alias|4253|63|通过markdown扩展名|
|test_base64_decoding_error|4263|69|通过原kind，额外精确消息|
|test_base64_size_is_checked_before_decode|4270|76|通过两阈值|
|test_bounded_xlsx_writer_rejects_growth_past_limit|4279|81|断言同义但无真实writer调用，MD-06，不能仅此标ported|
|test_epub_extract_text_from_bytes|4356|304|原三contains保留；不是完整html2text语义证明，MD-04|
|test_epub_invalid_zip_reports_epub_error|4370|317|通过错误kind|
|test_epub_extension_case_insensitive|4377|323|通过大写扩展名|
|test_check_office_encryption_with_encrypted_package|4391|224|通过kind/文件名/加密文字|
|test_check_office_encryption_missing_content_types|4503|233|通过kind/文件名|
|test_check_office_encryption_valid_document|4531|241|通过office结构接受|
|test_office_encryption_rejects_real_cfb_container_signature|4422|360|通过三个入口前置拒绝；后续writer不完整另记MD-04|

没有obsolete/merged行，12pending不是批准豁免。保留测试真实有效部分，不将提前Unsupported的附加测试当作Rust正常格式解析移植。

## 亲自运行的原始摘要

作业`20261104110558-927711`，命令：

```text
npx vitest run -c vitest.host.config.ts host/plugins/media/tests/document-parser.test.ts host/plugins/media/tests/ocr-settings.test.ts host/plugins/media/tests/media-commands.test.ts --maxWorkers=1
Test Files 3 passed (3)
Tests 73 passed (73)
Duration 23.50s
[作业 20261104110558-927711] 退出码 0
```

完整result输出无Errors；有WASI ExperimentalWarning，不当失败也不当三平台原生引擎证明。日志`/home/dsdev/.oc-jobs/done/20261104110558-927711.log`。本次MD-02/03是明确源码顺序/常量反例，尚无新增异常场景动态向量，证据标E3不冒称已复现。owner L18；MD-01协作L11，MD-04/05依公开平台能力，原未完成保持可追踪。

## main复验：MD-02/03签收（2026-11-04）

实现为`a34d959a6`；入口回归向量主体为`a274d4094`，a34d959a6修正日志观察方式为真实logger exporter。两者已在独立运行基线`0ca6ebaa5`，当前`2f83023df`对index.ts/media-commands.test.ts无差异。不是将报告提交当实现。

复用本review亲自提交的官方lane-gate子作业`20261104120904-53776d`：

```text
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills host/plugins/integration host/plugins/llm-providers host/plugins/media host/plugins/translation
host/plugins/media/tests/media-commands.test.ts (27 tests) passed
Test Files 153 passed | 1 skipped (154)
Tests 1445 passed | 3 skipped (1448)
原退出码 0；无 Errors / Unhandled 行
```

完整日志`/home/dsdev/.oc-jobs/done/20261104120904-53776d.log:25,35-42`逐条列出五个L18-M01向量，均实际通过，非过滤/平台skip。入口测试使用真实media插件/kernel和仓储，外部scheduler以seam控制；不称完整生产scheduler已验证。

- MD-02：`tests/media-commands.test.ts:319-329`验证运行快照与queued/running/none；生产get调用链已核对。
- MD-03：`:354-365`验证读失败先于取消；`:332-352`补证取消失败映射database-failed、保留原字幕、未启动索引。
- `:458-485`验证已提交字幕在调度失败时保留，info→start→warn顺序；对照Rust commands.rs:463-478。原成功导入预期completed改queued反映实际scheduler启动，未弱化原字幕/时间/导出断言。

该作业是强制门禁所选全目录集，非为本次两个finding重跑整套。外层首次前台超时没有自动收据，不影响已完成子作业的原始测试证据；不能称该首次外层exit0。MD-01/04/05/06、utilityProcess及三平台范围保持未签收。
````
<!-- END R1 ARCHIVE: host/plugins/media/ACCEPTANCE.md -->

<a id="r1-translation-acceptance"></a>
### 原文件：host/plugins/translation/ACCEPTANCE.md

<!-- BEGIN R1 ARCHIVE: host/plugins/translation/ACCEPTANCE.md -->
````markdown
# translation 独立验收（R1-review-llm，2026-11-04，standard-v2）

结论：不通过

**TR-04 main独立签收（2026-11-05）**：固定review `23ffb8c1a46e4f2fae2268481c4f44d98c00bae2` / main `fb463060d162d6c261ebb731180bcfaa833e95a2`，含实现69fbbb8ee与ioMessage修复/TESTMAP更新1d7b69d03，相关三文件与a747b6e89无差异。独立job `20261104165619-790745`仅ocr_command.test.ts，6passed、原exit0、无Errors/Unhandled；关闭缺注册/恒失败服务及指定文件OCR入口保证。1×1大字节样本不签大像素/D5/PSNR/平台，其他finding不随本项关闭。旧候选收件状态保留历史，末节为最新。

**TR-04 OCR候选收件（未签收）**：C1提供组合树`3db0b4737`，实际实现`69fbbb8ee`，命令测试`6029c2ac3/70278cd4e`；本轮四者ancestor main均exit1。仅核版本归属及测试标题，尚未独立运行。C1亲取`20261104154626-f3d816`的5pass属于并发期提供方证据，需owner锁定输入来源，不能作为本review结果。正常main后仅运行`host/plugins/translation/tests/ocr_command.test.ts`，覆盖两原decode_payload、临时清理/调用方文件保留、校验、专用OCR取消及压缩命令用例；>1.5MB样本实际为1×1 PNG，只证字节门槛触发再编码/不放大，不签大像素缩放或PSNR。候选TESTMAP:59-60两decode_payload仍pending，由实际生产写者更新，本review不改测试清单。TR-04保持开放，其他已派finding不重发。

基线：main `eeaf5bdc7`，review merge `21cc05604`。本文件按架构师/C1新增归属补建，未修改实现/测试/SPEC/TESTMAP。E1=Rust/TS动态差分（本次无），E2=生产入口测试，E3=Rust逐分支审读；额外纯函数/传输探针不冒充E2。

## 必须修复

- [ ] **R1-TR-01（P1，E3+TS实测）：流解析复制并弱化供应商结束语义。** `src/transport.ts:128-221,330`不用真实adapter.parseStream，任意非空finish_reason直接done；Rust `src-tauri/crates/dstu-tutor/src/translation/pipeline.rs:908-932`消费真实adapter事件。复现DeepSeek官方`finish_reason:"length"`：本插件返回content+done，而生产L01先输出content、随后DONE映射SafetyBlocked（Rust原测试`dstu-llm/src/providers/deepseek_harness_tests.rs:213-238`）。Gemini thought part也在TS:153无条件作为正文。应复用公开provider解析，不新增另一份规则。作业`20261104111058-b824c3` exit0输出见下。
- [ ] **R1-TR-02（P1，E3+TS实测）：产出后断流自动重试导致重复译文。** `src/transport.ts:501-512`将requestOnce连同readBody整体放进重试；Rust pipeline.rs:767-887仅请求阶段重试，流读取错误在:974直接返回。输入一个`prefix` delta后连接错误、maxAttempts=2，实测请求2次且onChunk输出`["prefix","prefix"]`。外层engine的“accumulated非空不重试”（`src/engine.ts:87`）挡不住这个内层重复。恢复请求/读取阶段边界，取消期间退避也需保留Rust:870-885的立即取消。
- [ ] **R1-TR-03（P1，E3）：翻译保存越权复制VFS仓储。** `repository/translations.ts:72-98,140-196,216-222`直接写resources/translations/folder_items，自造id及DEVICE_ID来源；`src/tool_executor.ts:725-747`实际调用这些副本。Rust executor委托VfsTranslationRepo/文件夹原子保存，表所有者是L11，不因SQL放repository就合规。用`vfs-repos/api.ts`公开业务方法/同连接D1接缝；其`types/services.ts:90`已有translations仓储。不得通过丢掉保存步骤“修”所有权。
- [x] **R1-TR-04：文件OCR公开命令/服务接线及指定生命周期已独立签收。** index.ts:53-84注册ocr_extract_text并将translation.ocrExtractText接真实L02 llmOcrPages，不再恒失败；ocr_extract.ts:16-37保先校验/建目录/解码/临时文件→FreeOCR→finally清理。job `20261104165619-790745`六条通过，包含原两decode_payload、成功/HTTP失败清理、调用方文件保留、校验次序、缺文件ioMessage错误与dedicated服务取消/再编码。Rust cmd/translation.rs:91-127及exam_engine.rs:350-397,876-924逐分支对照见末节。只签上述保证，非系统OCR所有平台/图像质量/全部OCR算法验收。
- [ ] **R1-TR-05（P2，E3）：流预算使用墙钟，缺少共享HTTP客户端语义。** `index.ts:23-24`和`src/transport.ts:293-296`注入Date.now，`:481`依赖它算deadline；Rust pipeline.rs:747,941用tokio Instant，且:798-825复用LLMManager已配置HTTP client。TS普通请求用裸fetch（:431-436），不等于含代理/客户端timeout的Rust客户端；不能因为声明了remaining变量（:422但未使用）就认定请求阶段有总超时。接共享transport和单调时钟，保持Rust原超时位置，不自行追加不同语义的总超时。
- [ ] **R1-TR-06（P2，E3）：事件失败的best-effort及日志边界未保留。** `src/commands.ts:42-49`直接emit/emitTo，异常会传播；Rust chat_popover.rs:198-201、candidates.rs:69等warn后继续。start业务info（candidates.rs:113、chat_popover.rs:214）也无对应。恢复按原层级记录日志/继续，防通知失败变整次翻译失败。
- [ ] **R1-TR-07（P2，E3）：真实工具注册/剩余保存测试未闭合。** 当前TESTMAP已由owner在1d7b69d03更新：两decode_payload指向真实ocr_command.test.ts，40ported/2pending口径保留，pending现为registers_before_general_catch_all及save_repo_normal_path_and_folder_error_mapping（:41,59）。旧OCR pending/表头问题不再作为当前事实；metadata/save/registry仍待相应owner生产证据，不能由OCR绿或机械A关闭。初审本地数组注册顺序不足仍见下方历史抽查，本轮未授完整工具消费链通过。

## 建议

主文件transport保留独立解析器会持续与L01漂移；先消除TR-01/02的真实回归，再补对应生产入口失败用例。报告必须区分测试目标模块可达与完整功能可用。

## 已核实通过

- [x] 5个已注册命令的名称/参数入口与契约一致，unit通过kernel输出null；空文本/候选限制/默认2上限3、候选profile、排序及取消命名按Rust实现。
- [x] 现有command suite从kernel invoke进入真实translation，LLM配置/外部fetch是seam，不是把被测命令替换掉；33条定向测试通过不覆盖上述反例。
- [x] lang检测与分段核心抽样断言保留；文字按Unicode字符计算，没有用UTF-16 length替代这些长度。

## 命令/分支审读清单

初审时本插件为5个已注册IPC加1个未完成OCR契约；当前OCR已接入，实际6个IPC，仍不足15个不同命令，未把服务/分支虚报成命令。下表保留初审6个入口及9个复杂分支的历史定位，OCR最新main闭环见末节。TS相对本插件；Rust前缀`R=src-tauri/crates/dstu-tutor/src/translation/`，契约`contracts/ipc/L02-llm-manager.json`。

| # | 入口/分支 | 结论、证据 |
|---|---|---|
|1|translate_text_stream|入口通过、流有TR-01/02/05；index:31-33→commands:198-206→engine:13；R mod.rs:50/pipeline.rs:137；空文本错误与cleanup顺序见engine:22-25、Rust translation-core engine.rs:63-77|
|2|translate_text_candidates|校验/default/结果分支通过，底层受TR-01/02影响；commands:209-340 ↔ R candidates.rs:91-340|
|3|cancel_translation_candidates|通过：三条c0..c2 pending取消、true；commands:343-347 ↔ R candidates.rs:346起|
|4|stream_chat_translation_aligned|校验/提示通过，流与事件问题；commands:350,364-384,416-482 ↔ R chat_popover.rs:205-354|
|5|stream_chat_translation_plain|通过所查prompt/共用校验，TR-01/02/06；commands:352,386-402 ↔ R chat_popover.rs:205-367|
|6|ocr_extract_text|问题TR-04；index:56-58、ocr_extract.ts:15-36 ↔ src-tauri/src/cmd/translation.rs:91-127|
|7|候选session/text/8000限制|通过校验顺序；commands:210-222 ↔ R candidates.rs:97-111|
|8|候选模型/解密失败|错误前缀及事件code通过，emit失败有TR-06；commands:230-244 ↔ R candidates.rs:124-152|
|9|候选成功/取消/全失败|保留空候选错误、取消优先、null detected_lang；commands:277-339 ↔ R candidates.rs:200-340|
|10|popover长度/上下文200字符|通过；commands:357-361,420-427 ↔ R chat_popover.rs:validate_request/truncate_context|
|11|HTTP状态错误分类|所查400/401/402/403/404/408/413/429/5xx通过；transport:224-240 ↔ R pipeline.rs:646-658|
|12|请求重试/已产出错误|问题TR-02；transport:501-512 ↔ R pipeline.rs:767-887,974|
|13|供应商stream terminal|问题TR-01；transport:128-221 ↔ R pipeline.rs:908-932|
|14|总时间/idle/取消|问题TR-05及退避取消；transport:355-405,408-462,481-513 ↔ R pipeline.rs:747,870-885,935-1032|
|15|工具translation_save|问题TR-03/07；tool_executor:725-747、repository/translations:140-222 ↔ src-tauri/src/chat_v2/tools/translation_executor.rs:1293-1410与VfsTranslationRepo|

没有把5个命令全部标“通过”：E3表只确认列出的分支，其他默认值/业务副作用仍依上方finding关闭。

## TESTMAP真实性抽查（15条）

`R`为Rust translation/pipeline.rs，`P`为tests/policy.test.ts，`T`为tests/transport.test.ts。前14条模块可从index→commands→engine/transport→policy真实到达。

| 原测试 | Rust行 | TS行 | 结论 |
|---|---:|---|---|
|translation_payload_uses_model_and_provider_output_budget|1083|T25|通过：65536/32768/1024三断言|
|translation_payload_preserves_explicit_output_budget|1102|T35|通过：8192覆盖|
|detect_japanese_with_kanji_mix|1117|P5|通过：假名优先ja|
|detect_chinese|1123|P6|通过：zh-CN|
|detect_korean|1131|P7|通过：ko|
|detect_english|1136|P8|通过：en|
|accented_latin_not_reported_as_english|1144|P9|通过：None→undefined|
|empty_text_returns_none|1153|P10|通过|
|segments_roundtrip_preserves_text|1158|P11|通过：separator拼接保真|
|small_text_stays_single_segment|1169|P15|通过：数量与内容|
|oversized_paragraph_falls_back_to_sentence_chunks|1177|P21|通过：多段/拼接|
|latin_sentence_chunks_keep_word_spacing|1189|P27|通过：空格与重建|
|no_punctuation_text_hard_splits_on_char_boundary|1201|P33|通过：中文无标点切段|
|popover_leaves_output_limit_to_model_configuration|chat_popover.rs:371|T53|通过：null上限/温度/2次/30s/120s|
|handles_translation_tools_and_sensitivity|src-tauri/src/chat_v2/tools/translation_executor.rs:1580|tests/tool_executor.test.ts:60|断言11项同义；工具真实消费尚待TR-07，不因实例导出签完整工具链|

TESTMAP没有merged/obsolete，无审批豁免可消除2pending。工具注册顺序的额外抽查明确不是真实中央registry，不能被同文件的纯函数通过掩盖。

## 独立运行/反例（均经jobs）

`20261104110558-d338db`：`npx vitest run -c vitest.host.config.ts host/plugins/translation/tests/commands.test.ts host/plugins/translation/tests/policy.test.ts host/plugins/translation/tests/transport.test.ts --maxWorkers=1`

```text
Test Files 3 passed (3)
Tests 33 passed (33)
Duration 9.50s
[作业 20261104110558-d338db] 退出码 0
```

无Errors行；完整日志`/home/dsdev/.oc-jobs/done/20261104110558-d338db.log`。没有运行Rust。

两个通过jobs运行的只读Node探针直接import生产模块，外部响应由固定输入控制，均exit0，无Errors行（它们打印反例，不是“等价断言通过”）：

- `20261104111058-b824c3`：同一DeepSeek length帧，输出`translation=[content(partial),done]`，L01 `productionAdapter=[ContentChunk(partial)]`，随后`productionTerminal=[SafetyBlocked(reason=length)]`。TS间对比并附Rust基准，不冒充E1 Rust动态差分。
- `20261104111202-1f4963`：真实streamTranslate，mock外部fetch流先给prefix再报传输错误，maxRequestAttempts=2。输出`{"attempts":2,"delivered":["prefix","prefix"],"error":"读取流失败: transport broke after delta"}`。证明TR-02；完整`node -e`复现命令存于对应jobs日志。

跨平台与utilityProcess未测。没有对含Map的序列化做哈希来替代语义比较。所有finding交L02/translation owner，TR-03需L11接缝、TR-04需平台协作；仅审计文件写入。

## TR-04正式main单文件复验与边界

固定review SHA `23ffb8c1a46e4f2fae2268481c4f44d98c00bae2`、main `fb463060d162d6c261ebb731180bcfaa833e95a2`；fb463060d、a747b6e89、1d7b69d03均为HEAD祖先，工作区干净。对a747b6e89比较ocr_pages_service.ts/ocr_extract.ts/ocr_command.test.ts无差异，未借用并发期提供方作业替代独立运行。实现69fbbb8ee、测试6029c2ac3/70278cd4e与后继1d7b69d03区分记录；a747b6e89是组合树，37acfe34c仅测试import注释。

```text
job 20261104165619-790745
npx vitest run -c vitest.host.config.ts host/plugins/translation/tests/ocr_command.test.ts --maxWorkers=1
Test Files 1 passed (1)
Tests 6 passed (6)
Duration 42.32s
原退出码 0，无Errors/Unhandled
```

经全局jobs提交，期间核生产链及Rust，亲取完整result。日志`/home/dsdev/.oc-jobs/done/20261104165619-790745.log`；有WASI ExperimentalWarning，无过滤/平台skip。D11 tokenizer单目标job164359-e55d67是另一固定基线/结果，未重跑它，未额外手动提交六目录或整llm。

### 实际入口与原断言

- 真实translation+llm安装到kernel，外部provider为本地HTTP，配置经真实llm.saveApiConfigurations保存；FileManager只替换绝对路径/根目录接缝，F7 nativeImage为真实实现。`index.ts:75-76`命令与:84服务共用extractText→ocr_extract.ts→llmOcrPages.freeText。原“未注册/无生产调用/恒失败”闭合。
- Rust cmd/translation.rs:139-144的PNG扩展名与8字节断言，在测试:60-64由实际临时路径扩展、provider data URL及字节长度保留；:148-152的不足签名字节/MIME webp优先，在:74-76保留。测试额外检查单次breaker取得、成功/401失败后临时目录为空，与Rust TempFileGuard::drop（:11-16）/主入口:100-125对应；调用方imagePath文件不删除。
- 无参数校验先于目录创建；有base64时mkdir先于解码，坏base64精确错误保留且不调用provider。缺文件经prepareSegmentationImageData:97-98使用ioMessage，上抛FileSystem原上下文，对照Rust exam_engine.rs:358-359。后继修复1d7b69d03的两处ioMessage真实分支不以提供方绿代替本轮结果。
- dedicated取消用例调用同一真实Host的公开llmOcrPages服务（不是IPC取消命令）：在provider响应挂起后abort，断言OCR cancelled、HTTP连接关闭、调用方文件保留；只剩generic_vlm时先Configuration失败、不读文件。freeText:239-260先allowRequest/过滤/空候选/图片准备/executeAcquired，与Rust exam_engine.rs:893-924对应。该用例证明所选取消/过滤路径，不声称所有竞速/重试分支全验。
- >1.5MB输入是真实1×1 PNG加尾部字节，spy仍调用原F7 resizeTriangleJpeg；断言原字节、1600×1600/85参数、实际JPEG输出及1×1尺寸。对应Rust exam_engine.rs:363-388的字节门槛和不放大路径。**不证明大像素缩放、Triangle像素等价、D5/PSNR或任何目标平台绑定**。

### 账本与整体验收

两原decode_payload由实际owner写为ported，指向上述生产命令测试，本review未改TESTMAP。当前仍pending的保存/metadata组合与真实registry项保持；TR-03/07及其他未决不因六条通过升级。

此时官方§5门禁（此前已在途）也完成：tip23ffb8c1a/basefb463060d/ok=true，at=2026-11-04T16:57:01.047Z。jobs165103-23127a typecheck、-ce8b10 boundaries、-c3c8c1 importable、-d7888d tests原code均0；tests2370passed/3skipped，无Errors/Unhandled。这是该tip真实全通过，区别于旧ab8f基线放行；新增报告提交后的收据仍须按自身tip生成，不能借用旧收据。
````
<!-- END R1 ARCHIVE: host/plugins/translation/ACCEPTANCE.md -->

## WP-C2-D1-001 — L04/translation 独立验收草案与 L07 phase0 抽检（2026-11-05）

结论：草案完成，L07 两条样本断言对应通过；chat/translation 均为初稿、非全域通过，最终 ACCEPTANCE 路径未获授权，不能计 B 级完成。

### 1. 基线、权限与证据口径

- 已完整阅读执行者协议、R1 任务卡、ORCHESTRATION-v3、standard-v2，以及本包 chat/translation/agent-skills 的 LANE、BLOCKERS、TESTMAP；本包优先于旧全域任务。
- 开工工作区干净；检测到其他工作树并行 vitest。`git merge --no-edit main` fast-forward：`ffca5bc6f` → **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**。以下源码行号、独立测试均以此实际 HEAD 为基线。
- `git show main:<path>` 核实 chat/translation 的 index/api 与 L07 PTC adapter 均存在且与审读工作区相同。未编译/运行 Rust、未安装依赖。唯一源文件改动为本 audit 的追加章节。
- 下列两个四反引号围栏是完整独立草案，可在获得路径授权后分别落盘；围栏中的路径全部相对仓库根目录。它们不覆盖本文上方历史归档，也不继承旧“通过”声明。
- 初稿只对每域选定的三个高风险入口逐分支审读；未达到每域 15 命令/15 原测试独立对照的全域门槛。现有补充测试的绿色不抵消静态发现。

### 2. 草案 A：最终目标 `host/plugins/chat/ACCEPTANCE.md`

````markdown
# L04-chat-session 独立验收草案（R1-review-llm，2026-11-05）

结论：不通过。初稿/覆盖不足，非全域通过；本稿存于 audit，尚未授权创建本目标文件，不构成 B 级完成。

基线：967f43c7547d1ed29a7e3d736b8118fb95d3661e。独立审读 index/api/SPEC/TESTMAP 与实际 Rust/TS；下述三入口的 handler 全分支及所列下层分支均已读。其他入口不签收。

## 命令/风险分组

| 组 | 命令与风险 | 本稿覆盖 |
|---|---|---|
| D1 课题目录 | chat_v2_create_group / update_group / get_group / list_groups / restore_group：跨 VFS owner、root 绑定、派生字段、坏行回读 | create_group 完整入口及 ensure_group_folder/root 解析；其余仅辅助核差 |
| 课题永久删除 | chat_v2_delete_group：活动流/Anki 阻断、VFS 引用补偿、级联事务 | 完整入口及组所有会话枚举/删除事务；发现漏调用 |
| 快照输入 | chat_v2_import_session：原文 serde、精确整数、ID 重写、事务回滚 | 完整入口；export_meta/export_messages 仅追踪输入来源 |
| 未审域 | send/wake/retry/edit/continue、变体、goal、workspace、审批、附件、迁移、搜索、JSONL 导出 | 保留未审，不凭 meta.commands 或旧 SPEC 勾选升级 |

## 必须修复

- [ ] **C04-01（复核确认，原 finding）快照 typed 解码及写入语义仍不等价。** Rust `src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:158-170,195-219` 先完整 `from_str::<ConversationSnapshot>` 再比较 format/version；TS `host/plugins/chat/src/snapshot.ts:100-118` 为 `JSON.parse(...) as ConversationSnapshot`。缺 session 可在 :138 触发 TypeError；`messages:null` 被 :117 当空数组接受，Rust Vec 拒绝；重复已知字段/整数词法/嵌套结构/错误位置未校验。`snapshotJson` 在 IPC 中只是 string，外层契约无法补这个 decoder。现有 `tests/snapshot.test.ts:171-179` 以 `session:{}` 期待 format/version 错误，Rust 会先拒绝缺失 ChatSession 字段，不能把这条绿例当等价证据。
  - 原文 i64/u64 在 `JSON.parse` 时已可能舍入，例如消息 timestamp=9007199254740993；不得等到写库或 IPC 再补精度。Rust `MessageBlock` 在 `src-tauri/crates/dstu-core/src/agent.rs:341-359` 保留 i64 时间，`block_index` 是 **skip_serializing + default，仍可反序列化**；Rust import :427 复制它，TS import :220-238 未复制，仓储 `host/plugins/chat/repository/blocks.ts:94` 默认为 0。
  - TS import :221-231 把缺省/显式 null 的 toolInput/toolOutput 都显式赋 null；仓储 :87-96 因属性存在会写 JSON 文本 `"null"`。Rust Option 的 None 经 import :402-421 保持 None，落库应为 SQL NULL。这是导入调用方的值构造差异，不应改坏仓储支持 Some(Value::Null) 的合同。
- [ ] **R1-D1-C04-09（关联 C04-02/06）课题删除漏 VFS 引用递减。** Rust `handlers/group_handlers.rs:321-325` 在事务删除前逐会话调用 `decrement_vfs_refs_for_session`；TS `src/register.ts:203-204` → `src/group-actions.ts:298-320` 完全没有 refs/log 参数或调用。Rust `handlers/manage_session.rs:1147-1184,152-238` 为逐消息收集、不去重、取连接与每资源各重试一次，最终失败记 warn/error 后继续删除；不是“VFS down 则阻断”。现成 TS `src/reference-counts.ts:19-55` 和 `index.ts:200-205` 已有公开 owner 适配。由 L04 接上现有路径，不能省略副作用，也不要另写 resources SQL。SPEC :701 的“Host 省略”不是已批准的平台差异。
- [ ] **R1-D1-C04-10 删除准入缺僵尸 Anki 回收。** Rust `handlers/manage_session.rs:274-313` 在 count 前调用 reaper：有回收 info、空结果继续、失败 warn 后保守 count；TS `repository/sessions.ts:140-146` 直接 count。崩溃遗留 pending/running 块可能永久阻止课题删除。L24 有 `host/plugins/chatanki/src/block-reap.ts` 实现，但本基线 `chatanki/api.ts` 无公开 reaper 出口；需 C1 协调 L24 发布与 L04 消费，保持 chat 表单写者，不能通过跨插件私有 import 补接。
- [ ] **R1-D1-C04-11 create_group 的排序与采时位置不同。** Rust `handlers/group_handlers.rs:155-161` 对非空列表直接 max，只有空列表默认 0，且在 folder/root IO 前取 now；TS `src/group-actions.ts:78-83` reduce 初始 0 把负数排序截成 0，并在 IO 后采时。`types.rs:813,857` 明确 i32，公开 update_group 允许合法负数：现有最大 -2 时 Rust 下一项 -1，TS 为 1。按源语义修正，无需增设配置或兼容层。
- [ ] **R1-D1-C04-12 组仓储 typed 回读与日志缺口。** `repository/groups.ts:35-42` 对混合数组过滤保留字符串，Rust `repo.rs:1169-1177` 的 Vec<String> 整体失败回退 []；例如 `["skill_a",1]` 不能保留 skill_a。TS :45-64 无 Rust :1131-1145 的列类型/i32 检查；坏时间通过 `src/types.ts:6-7` 静默回 epoch，漏 Rust :1155-1166 两条 warn。删除组时 `groups.ts:253` 调 deleteSessionHard 未传 logger，亦漏 Rust `repo.rs:547,559-562` 的删除日志。仅修这些可定位分支，不按聚合计数补日志。

## 三入口逐分支记录

契约逐条定位：`contracts/ipc/L04-chat-session.json:651-695` → group_handlers.rs:145；`:779-817` → group_handlers.rs:285；`:1948-1978` → snapshot_handlers.rs:189。TS `index.ts:94-96,84,343-352` → `src/register.ts:191-204,228-229`，api.ts:14/66-67 公开 generated 类型及同连接组仓储；不是只靠命令声明判可达。

| 入口 / Rust 完整分支范围（均在 src-tauri/crates/dstu-agent/src/chat_v2） | TS 对应（均在 host/plugins/chat） | 核实结论 |
|---|---|---|
| create：get conn、active/workspace 过滤、空/非空 max、now，`handlers/group_handlers.rs:153-161`；查询失败与坏行 skip，`repo.rs:744-784` | `src/register.ts:191-192`、`src/group-actions.ts:78-83`、`repository/groups.ts:75-88` | 过滤/排序查询与传播路径存在；负值 max/采时见 11，坏行语义见 12 |
| folder：取 VFS 连接失败、无 pinned/不存在/child/deleted 新建；有效 root 唯一标题、同名免写/改名、trim 去重置首，`handlers/group_handlers.rs:21-104` | `src/group-actions.ts:173-243`；`repository/vfs-folders.ts:21-37` | 已核全部 if/错误落点；写入走同一 conn 的 L11 FolderRepository，非本地 SQL 副本 |
| root：None/空白清除、绝对路径拒绝、解析失败前缀、成功取本机 path；忽略客户端 path；默认 Vec/Option、create 失败，`:111-193` | `src/group-actions.ts:45-102`，`index.ts:163-170` | 同序 folder→root→insert；root 失败不回滚已创建 folder 与 Rust 相同；平台路径语义仅静态读，未跑 Windows |
| delete：缺组/active 拒绝；group_id 与 legacy marker 会话；逐个 stream→Anki 检查，`:292-320`、`repo.rs:992-1037` | `src/group-actions.ts:302-317`、`repository/groups.ts:140-167` | handler 文案/顺序一致；Anki reaper 先行分支遗漏见 10；不擅自取消活动流 |
| delete：所有校验后 refs，再 IMMEDIATE；事务内缺组/active/枚举/每会话/删组零行/commit，`:321-326`、`repo.rs:1040-1076,546-563` | `src/group-actions.ts:318-320`、`repository/groups.ts:242-258` | chat 单库事务存在，refs 全缺见 09；不发原实现没有的事件、不额外引入 runtime-root 清理 |
| import：50MiB UTF-8、typed 首错、format/version，`handlers/snapshot_handlers.rs:195-219` | `src/snapshot.ts:96-118` | 大小限制一致；typed/精度/错误差异见 C04-01 |
| import：重复 ID 映射、孤儿过滤告警；object metadata 加 importedFrom，非 object 保留；title Option、去 group/tags、锁标题、保 createdAt，`:223-288` | `src/snapshot.ts:121-164` | 对结构合法输入控制流对应；不外推为输入 decoder 通过 |
| import：message/block/variant ID；未知 blockId 保原值，未知 parent/supersedes 清空；active variant 按旧索引；shared context 五类 ID 缺失清空；tool JSON 仅精确字符串替换，`:290-429` | `src/snapshot.ts:166-238,30-44,295-298` | 已读所有 Option/数组/递归分支；blockIndex 与 Option 持久化差异见 C04-01 |
| import：state 草稿裁剪；有/无资源引用 warning、不 relink；取连接→IMMEDIATE→session/messages/blocks/optional state→commit→info→计数，`:431-500` | `src/snapshot.ts:240-292`，`src/handlers.ts:18-22` | 事务顺序、commit 单独错误前缀、Display 命令边界对应。TS register 提前取 db，Rust 校验重写后 :462 才取连接，双重失败时错误优先级仍需修正（并入 C04-01）。同步导入没有 Rust cancel token；不能凭没有 AbortSignal 自造取消语义 |

## 已核实通过（仅以下范围）

- [x] D1 folder 读写使用 L11 api.ts 类型/服务、沿用同一个 VFS conn；chat 的 group/session 事务仍在 owner 仓储。证据：index.ts:160-183、repository/vfs-folders.ts:21-37、repository/groups.ts:242-258。
- [x] create 返回 SessionGroup 可选字段省略、Vec 默认、camelCase 与 `types.rs:787-839` 对应；i32 非全正数，排序缺陷另列。snapshot 的外层参数是 string，不是结构已验的文件对象。
- [x] import 事务写入顺序、孤儿/VFS warning 的相对顺序、标题锁定/草稿裁剪和精确 ID 重写已在真实命令补充测试中有断言（tests/snapshot.test.ts:58-168）；这些用例不属于 15 条原测试全覆盖的证明。

## 运行证据与测试边界

- 本包命令：`npx vitest run -c vitest.host.config.ts host/plugins/chat/tests/groups.test.ts host/plugins/chat/tests/snapshot.test.ts -t 'create_group|delete_group|exports meta|import trims|import rejects' --reporter=verbose`，共享 job `20261105140408-683524`；原始最终结果见本包第 5 节。
- groups 的生产装配为真实 L11/F3 + chat（tests/groups.test.ts:29-50）；runtimeRoots 是明示 L05 外部接缝。snapshot 使用真实 F3/chat，VFS 为未使用的夹具。不能用该夹具证明漏掉的 refs 副作用。
- 亲读三个入口所需补充用例，原 Rust 测试等价抽样没有凑到 15 条；chat 本稿明确 **初稿/覆盖不足，非全域通过**。

## 未审项与后续验收

- [ ] 其余约 104 个契约命令逐入口全分支、15 条以上原 TESTMAP assert/expect 对照，以及全部 typed/日志/生命周期复核。
- [ ] C04-01 完整 struct/序列/重复字段/首错/整数与持久化 NULL；当前公共 F4 reader 的实际可用接口需实现者核对，不沿用旧“只能等 jsonc-parser”判断。
- [ ] L03 chatToolRuntime 与真实 admitted dispatcher。`chat/index.ts:120-125` 已消费 L07 roster，`src/service.ts:77-78` 可组装；`chat-pipeline/src/execution-runtime.ts:215-224` 仍因未提供 chatToolRuntime 走缺能力分支，不能声称完整工具链闭合。
- [ ] Windows/macOS、真实 Electron utilityProcess/打包、50MiB 导入的 Host 非阻塞性及全库 serde 读回。这里只核到选定入口，不授跨平台/C 级。
````

### 3. 草案 B：最终目标 `host/plugins/translation/ACCEPTANCE.md`

````markdown
# Translation 独立验收草案（R1-review-llm，2026-11-05）

结论：不通过。初稿/覆盖不足，非全域通过；六个 IPC 命令的域也未达到 15 原测试独立复核门槛。最终目标未授权，本稿不计 B 级。

基线：967f43c7547d1ed29a7e3d736b8118fb95d3661e。覆盖三个高风险入口全部 handler 分支：translate_text_candidates、stream_chat_translation_aligned（共用 plain 分支亦读）、ocr_extract_text；另外核 cancel 的三通道广播和 D1 保存 owner，未签完整 translate_text_stream/工具执行流程。

## 真实命令与 owner（不能按 LANE 标题猜归属）

| 命令/服务 | Rust 入口及真实实现 | TS 生产入口 / owner |
|---|---|---|
| translate_text_candidates / cancel_translation_candidates | `src-tauri/src/translation/candidates.rs:21-39` 薄封装；`crates/dstu-tutor/src/translation/candidates.rs:91-356` | `host/plugins/translation/index.ts:38-44` → `src/commands.ts:215-355`；L02 翻译域，取消 registry 归 llm |
| stream_chat_translation_aligned / plain | `src-tauri/src/translation/chat_popover.rs:16-33` → `crates/dstu-tutor/src/translation/chat_popover.rs:205-364` | index.ts:45-50 → commands.ts:357-490；L02 翻译域 |
| translate_text_stream | `src-tauri/src/translation/mod.rs:35-41` → dstu-tutor → dstu-translation-core | index.ts:35-37 → commands.ts:204-212 → engine.ts；本稿未做该 engine 全分支 |
| ocr_extract_text | `src-tauri/src/cmd/translation.rs:90-127`；文件根为 `crates/dstu-storage/src/file_manager.rs:169-219`；推理调用 llm_manager | index.ts:53-76 → src/ocr_extract.ts:16-37；llm/index.ts:159 提供 llmOcrPages，native image 属 F7，base64 属 F4；不是 L04 chat OCR 命令 |
| translation_save 工具，非新增 IPC | `src-tauri/src/chat_v2/tools/translation_executor.rs:1293-1459`；create 走 VfsTranslationRepo | translation/api.ts:17,34-42 → tool_executor.ts:1084-1162；资源/翻译/目录写入 owner 为 L11 vfs-repos，不是 translation 本地仓储 |

## 必须修复

- [ ] **R1-TR-08 候选出站 serde 省略规则错误（本包新证据）。** Rust `src-tauri/crates/dstu-tutor/src/translation/types.rs:101-103,115-117,148-160` 的成功 candidate.error、None detected_lang、None code 均 skip_serializing_if。TS `host/plugins/translation/src/commands.ts:317,330,337,342,345` 显式写 null。显式源语言 en 的普通成功就可达，不是罕见构造。`tests/commands.test.ts:250` 甚至期望 complete.detected_lang=null，不能据此签收；SPEC.md:40 的“候选显式 null”与真实 Rust 不符。kernel/commands.ts:248-261 仅 wire 转换/校验，不自动按 serde 删除 null，需在域输出处修正。
- [ ] **R1-TR-02（取消清理残差）popover 未做终局 clearCancelArtifacts。** Rust `pipeline.rs:612-638` 的 stream_translate 包装在 inner 返回后（完成/取消/错误）清通道和 pending registry，再交给 popover；TS commands.ts:460-490 直接用 inner 等价 streamTranslate，transport.ts:393-396 仅 clearCancelStream。llm/src/control.ts:20-42 证实取消会写 pending，而 clearCancelStream 不删它；流内 abort 时 reader 直接返回 cancelled，pending 可残留，同名重试被假取消。应补 popover 的终局清理，不改分段 inner 的 registry 保留责任。
- [ ] **R1-TR-06（复核确认残差）终态业务日志仍缺。** Rust candidates.rs:293/314-317/329-334/350 的取消 info、全部失败 warn、完成 info、取消命令 info，在 commands.ts:327-354 均无对应；chat_popover.rs:299/303-306/311/324-327/339 的 empty warn、complete/cancel info、incomplete/error warn，在 commands.ts:475-490 均缺。start 与 emit failure 日志已在 commands.ts:50-54,230,436，本稿明确认可已修部分；不要以共享 transport warn 代替不同上下文的终态日志。
- [ ] **R1-TR-03（owner 接口已到 main，消费者未接）** `vfs-repos/types/content.ts:531-540` 实际已公开 `setMetadataJsonOnlyWithConn(conn,translationId,metadataJson):void`；`repository/translations.ts:448-452` 实现原 SQL、参数顺序、0 行原错误，不改版本/updated_at。translation 的 `src/tool_executor.ts:30-34,754-760` 仍索要 `updateTranslationMetadata(conn,id,JsonValue)`；真实 L11 实例不满足这个额外面。由 L02 消费现有同连接 owner，并用已有精确 JSON 序列化出口准备字符串；无需让 L11 再造同义方法。保存顺序仍是 create 成功→消费 cache claim→metadata 尽力写/warn→watch，不应包成额外跨步骤事务。BLOCKERS.md:3-12/LANE 的“metadata 未发布”已过时，因本包禁止改这些文档，只在此纠偏。
- [ ] **R1-TR-07 真实中央工具消费仍未闭合。** index.ts:52,77-85 只发布 toolExecutor，没有注册到 L07 roster；L03 仍缺 chatToolRuntime（chat-pipeline/src/execution-runtime.ts:215-224）。两条保存/注册顺序 TESTMAP 保持 pending 正确；不可用本地 array.find/metadata 端口夹具签收。

## 三入口全部分支对照

下表 Rust 简称 C/P/O 分别为 `src-tauri/crates/dstu-tutor/src/translation/candidates.rs`、同目录 `chat_popover.rs`、`src-tauri/src/cmd/translation.rs`；TS 路径以 `host/plugins/translation/` 为根。

| 入口 / 分支 | Rust | TS | 结论 |
|---|---|---|---|
| candidates session/text 空白、8000 Unicode chars、默认2 clamp1..3、auto检测/显式源语言 | C:97-122 | src/commands.ts:215-235 | 顺序、字符计数、常量对应；numCandidates 的 u32 由 kernel 入站契约校验，不能拿内部服务无校验外推 IPC |
| 模型配置失败 / 密钥失败的事件+AppError；三 profile prompt/温度 | C:124-175 | :236-269 | 分支和文案对应；f32 经请求 Value 的数值精度仍列未审 |
| 每候选 chunk；Completed 空白/非空、Cancelled、Incomplete、StreamFailure；所有返回前 clear artifacts | C:176-248 | :258-307 | 结果分支、事件顺序、每候选清理对应 |
| join_all 顺序→success/failed/cancel 汇总、首错、排序；取消优先、全失败、部分/全部成功 | C:254-342 | :310-347 | 控制流对应；省略规则/日志见 TR-08/06 |
| cancel 原样 sessionId、0..2 广播、true | C:346-356 | :350-355 | 行为对应；命令 info 缺失 |
| popover request_id/source 空白和8000限制；context None/空/≤200/>200；aligned/plain 完整 prompt 分支 | P:94-191,211,254-258 | src/commands.ts:364-410,427-456 | 两种 prompt 及截断方向对应，不把 plain 当另一个独立抽查额度 |
| 模型/密钥失败；options 0.2/no max/30s idle/120s total/2尝试/关闭thinking；delta 不含 accumulated | P:82-91,223-285 | :412-420,440-468 | 选定 handler 形状、参数、错误路径对应；AppError Display 为 message（dstu-core/src/models.rs:1038-1041） |
| Completed 空/非空、Cancelled、Incomplete、Err | P:287-342；pipeline.rs:612-638 | :469-490；transport.ts:393-396 | 返回/事件主分支存在；漏终局 pending 清理及日志见 TR-02/06 |
| OCR 两参数皆 None；base64 优先（包括空串）；path 原样；mkdir→decode→UUID写入；各 IO/解码失败 | O:19-84,96-113 | src/ocr_extract.ts:16-29；src/ocr_payload.ts:15-69 | 20MiB 粗判/解码后限制、签名→MIME→png、Validation/FileSystem 路径对应；依赖 F4 strict decoder |
| OCR freeText 成功/失败；临时 guard 删除、删除失败忽略、调用方 path 不删 | O:11-16,115-127 | src/ocr_extract.ts:30-37；index.ts:63-72 | try/finally 对应 RAII；命令本体不监听取消，与原入口一致；不是声明底层全 OCR 竞速已验 |
| OCR writable dir primary/OS data/temp fallback，每处探针失败日志与清理 | dstu-storage/src/file_manager.rs:169-219 | src/ocr_extract.ts:40-65；index.ts:56-62 | 已读各回退，仍是 translation 中 F3 逻辑副本；owner 归并待 C1/F3，未把 fallback 当新架构批准 |

共享 transport 已亲读 `src/transport.ts:201-398` 对照 Rust `pipeline.rs:734-1034`：同一个 provider adapter；raw DONE 在 adapter 前；SafetyBlocked 优先于后续 Done；EOF 不主动 finish_stream；读取失败不重试；请求建立阶段才重试；backoff/cancel、reader.cancel/releaseLock、单调时钟 deadline 有具体落点。此次没有重跑上述历史全部回归，不签所有 provider/网络错误平台差异。

## 已核实通过（限定范围）

- [x] index.ts:22-29 真正注入 llm/llmCodexAuth/llmHttp，三个被审 handler 实际注册并经同一公开 translation 服务可达；未以 fake helper 冒充命令。
- [x] OCR 两条原 Rust assert 独立核实：O:139-144 的 png + 8 bytes → tests/ocr_command.test.ts:56-69 的真实命令、临时路径、HTTP image data URL/8字节及成功/401清理；O:148-152 的签名不足回退 webp → :71-80 的路径/载荷扩展及调用方文件保留。外部接缝为 F3 路径与设置/密钥；llm/provider 请求链是真实实现。
- [x] candidates/popover 用例经 kernel.invoke 进入生产 handler，明确 fakeLlm/fetch 外部端口（tests/commands.test.ts:47-98），只证明调用方语义，不是实际模型配置/密钥/网络集成全部通过。
- [x] D1 create 的 owner 调用和 metadata 的尽力保存顺序独立核实：tool_executor.ts:732-760,1084-1134 对照 Rust translation_executor.rs:1340-1434。L11 metadata 方法已在 main，旧“提供方未发布”不成立；消费者未接问题仍开放。

## 测试与未审项

共享 job `20261105140339-a95cde`：commands.test.ts + ocr_command.test.ts，按 `translate_text_candidates|cancel_translation_candidates|stream_chat_translation|chat popover|decode_payload|validates before OCR` 过滤；2 文件、9 passed / 0 failed / 13 过滤 skipped，exit 0，无 Errors/Unhandled。原始日志 `/home/dsdev/.oc-jobs/done/20261105140339-a95cde.log`。不把 13 未执行项记为 pass，也不为保持该绿例而保留 TR-08 的错误 null 期望。

- [ ] 剩余 40 条原测试逐断言独立核验（此次只独立确认 OCR 原2条）；完整 engine、工具 translate/read/save、持久化原文/精度、cache 并发与跨 Host logger 隔离。
- [ ] TR-02 popover 真实取消后的 pending 清理回归，TR-06 各终态日志回归，TR-08 返回/事件键缺省的精确对照。
- [ ] F3 文件根 owner 正式装配；当前同步 mkdir/write/unlink 最大20MiB 对 Host 事件循环的影响、F7 大像素 Triangle/JPEG 等价、Electron/三平台实测；原 Rust 同步 IO 事实不等于已满足 Host 非阻塞规则。
- [ ] SPEC 的 f32/时间/None 声明不能未经核实继承；本次只确认候选省略规则确有差异，不签全部数字/时间出口。
- [ ] 路径授权后由复核者正式落盘，并在缺陷修复与覆盖达标后重新验收。当前初稿/覆盖不足，非全域通过。
````

### 4. L07 phase0 映射抽检

**抽样框与结论：** `git diff 87b1032a7 967f43c75 -- host/plugins/agent-skills/TESTMAP.md` 恰为 20 条 pending→ported；区间内只有映射提交 **`d82417d62109714f9a83d12bbe85587551b36b1a`**，其父为 **`87b1032a7b521fa74bfb7b7bbf8c4e07c69bb494`**，phase0 tip 为 **`967f43c7547d1ed29a7e3d736b8118fb95d3661e`**。按提交 N=20，ceil(20×10%)=2；有意选择不同文件且涉及真实运行/失败路径的 2 条（不是按标题抽签收）。该区间两测试文件与 PTC executor/runtime 实现无 diff。

#### 样本 1：准入拒绝仍为成功脚本，失败进入 envelope/trace

- 精确 Rust ID：`crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs::tests::execute_admission_rejection_surfaces_in_envelope_and_trace`；位置 `src-tauri/.../ptc_executor.rs:1056-1081`。已读完整测试和 :763-824 StubDispatcher/test_context；原 Rust 本身就通过 Reject 外部准入接缝。
- TS 去向：`host/plugins/agent-skills/tests/ptc-executor.test.ts:251-266`，同名用例；stub :28-70 是原 Reject 接缝，真实 `PtcExecutor.execute` 与 F7 starlark 未替换。
- 五组 assert → expect：Rust :1067-1071 `result.success` → TS :258；:1073 `value.ok=false` → :261；:1074-1077 error 含 AUTHORITY_BLOCKED → :262；:1079 trace len=1 → :264；:1080 trace[0].ok=false → :265。脚本文本、调用名、无参数、拒绝内容均对应。没有删除边界或以字面量输出自证。
- 生产可达：`agent-skills/index.ts:222-236` 注册 `PtcToolExecutor` → `src/tools/ptc-tool-executor.ts:39-44,54-78,81-88` → `ptc-executor.ts:348-422`，拒绝 catch :389-406 包装失败并由 broker 记录。测试测的正是这份实现。
- **结论：该条原单元测试断言等价通过。** 不能据此关闭 panic/准入拒绝分类、父监听清理或 L03 实际工具循环等旧未决。

#### 样本 2：受控写走同一 broker 且标记 side effect

- 精确 Rust ID：`crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs::tests::controlled_write_call_uses_same_broker_and_marks_side_effect`；`src-tauri/.../ptc_runtime.rs:1204-1221` 全文已读。
- TS 去向：`host/plugins/agent-skills/tests/ptc-runtime.test.ts:125-140`，同名用例；broker 构造 :27-41，valueOf :48-51 失败即抛，不会把失败结果冒充成功。
- 五组 assert → expect：Rust :1207 broker 收到 `builtin-workspace_artifact_write` → TS :136 精确 seen 单元素数组；:1216 result.ok=true → :135 整对象精确相等（并核 output.path）；:1218 trace len=1 → :137；:1219 side_effect=true → :138；:1220 tool 精确名 → :139。两侧均使用相同 bare-name 脚本和 `{path:"report.md",content:"ok"}`，外部 pump 只返回同样 report.md。
- 生产可达：上一样本的 PtcExecutor :410-422 → `ptc-runtime.ts:679-699` 的 F7 evaluate/call 回调 → :382-428（normalize、allowlist/write 判定、预算、dispatch、trace side_effect）。不是只 export 未调用的副本。
- **结论：该条原单元测试断言等价通过。** 不是证明真实 workspace 文件已写入；原 Rust 样本也只断言 broker/pump 语义。

#### 运行与签收边界

共享 job **`20261105140231-6da45c`**，命令：

```text
npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/ptc-executor.test.ts host/plugins/agent-skills/tests/ptc-runtime.test.ts -t 'execute_admission_rejection_surfaces_in_envelope_and_trace|controlled_write_call_uses_same_broker_and_marks_side_effect' --reporter=verbose
Test Files  2 passed (2)
Tests       2 passed | 47 skipped (49)
退出码 0；无 Errors/Unhandled，只有 WASI ExperimentalWarning。
```

日志原件 `/home/dsdev/.oc-jobs/done/20261105140231-6da45c.log`；47 是标题过滤，不是新增 skip。未重跑整包455测试，未引用实现者测试数字冒充独立运行。

抽样未发现“按名字硬映射”或原断言变弱反证，**本批两条抽检通过，不列整包拒收候选**；另外18条未独立签收。旧 BLOCKERS B1 的“main 没有任何 L04 registry 消费”已过时：chat/index.ts:120-125 / src/service.ts:78 有真实贡献读取和组装入口。但 L03 `chatToolRuntime` 无生产提供者（execution-runtime.ts:215-224），所以映射的单元等价不等于完整 tool loop 或 L07 B 级。`ptc-production-wiring.test.ts:39-51,106-117` 亦是明示 dispatcher 接缝，未拿该名字代替端到端证据。

### 5. 本包验证原件、计数及交付边界

所有验证均经 `/home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs`，cwd 为本独立工作树；原始日志/JSON 位于 `/home/dsdev/.oc-jobs/done/<id>.{log,json}`。

| 检查 | job id | 原 exit | passed / failed / skipped | Errors |
|---|---|---:|---|---|
| 起点 `npm run typecheck:host` | 20261105140042-4375db | 0 | 不适用 | 无 |
| L07 两条精确样本（见第4节） | 20261105140231-6da45c | 0 | 2 / 0 / 47（过滤） | 无；WASI warning |
| translation 所选命令/原OCR向量 | 20261105140339-a95cde | 0 | 9 / 0 / 13（过滤） | 无 |
| chat 三入口所需命令向量 | 20261105140408-683524 | 0 | 6 / 0 / 9（过滤） | 无 |
| 三插件 index 的 Node 原生类型擦除 importable | 20261105140734-0725aa | 0 | 不适用；importable: ok | 无 |

chat 原始摘要：`Test Files 2 passed (2); Tests 6 passed | 9 skipped (15)`，47.09s；translation：`Test Files 2 passed (2); Tests 9 passed | 13 skipped (22)`，21.63s；L07：`Test Files 2 passed (2); Tests 2 passed | 47 skipped (49)`，7.70s。均保持原断言/超时，过滤只限定本包审读所需入口。chat 的不等价快照错误期望与 translation 的不等价 null 期望虽绿，已明确登记，测试绿不能覆盖源码反证。

TESTMAP 按实际行去向计数，不采旧生成表头。前=合并 phase0 后、后=本包交付；无任何去向改动：

| 文件 | 总行 | pending 前→后 | ported 前→后 | obsolete 前→后 | merged 前→后 |
|---|---:|---:|---:|---:|---:|
| host/plugins/chat/TESTMAP.md | 527 | 122→122 | 386→386 | 19→19 | 0→0 |
| host/plugins/translation/TESTMAP.md | 42 | 2→2 | 40→40 | 0→0 | 0→0 |
| host/plugins/agent-skills/TESTMAP.md | 351 | 28→28 | 323→323 | 0→0 | 0→0 |

L07 的历史 base→phase0 为 pending48→28/ported303→323，是 d82417d6 的改动，不是本包贡献。chat 表头174/334与 L07表头0/351、尾注48/303均非当前事实；本包授权仅 audit，所以不越界更正这些文档。

**未完成/阻塞与责任：**

- 草案已具备最终文件内容，但 `host/plugins/chat/ACCEPTANCE.md`、`host/plugins/translation/ACCEPTANCE.md` 都不在本 lane allowlist。请 C2/C1 授权正式复核落盘工作包；本次不创建目标、不申请账本 B 提升。
- L04 负责 C04-01、09、11、12 的自有修复；C04-10 需 C1 安排 L24 公开 reaper 并由 L04 消费。具体源语义/接口如草案，不给其他 lane 点对点自行派发。
- L02 负责 TR-08/02/06 与 TR-03 消费者接线；L11 已有 `setMetadataJsonOnlyWithConn(SqlExecutor,string,string):void`，不应继续阻塞在旧方法名。TR-07/真实 tool runtime 需 L03/L04 组合；F3 文件根归属/三平台资源仍由 C1/C2 收口。
- 未审的全域命令/测试、平台和完整工具环均保留 `- [ ]`，不得把本包有限绿例扩大为全域通过。

**供 C2 再抽检的两条：** 优先复核第4节两个完整 Rust ID（准入拒绝/受控写 broker），证据含原 assert 对应、生产调用链、job 与原 exit。D1 后继修复优先复核 delete_group 的 refs 及候选 serde 省略规则。

**提交/最终自检：** 本节原件齐备后仅提交本 audit，合并交付时最新 main，再运行共享绝对路径 lane-gate.mjs。最终 tip/base、lane-gate job/原 exit/子项回执在 `coord.mjs wp-done` 的交付报告首部记录（工具支持 stdin）；不为回填自检 SHA 再改已验证 tip。本节及两份草案作为该交付报告正文。

## WP-C2-VERIFY-010 — L07 workshop 13条既有映射生产资格复核（2026-11-06）

**结论：13/13 不通过（1.1 生产可达不成立）；断言等价本身成立。** 应把这 13 行去向撤回 `pending`，测试文件与断言保留。

### 1. 基线与口径

- 固定 main `e1204ee8a02f1cfb3255fb1a75bb234c72236ce9`（`git merge --no-edit main` 快进，HEAD=main）；`4723d8d46` 是其祖先（exit 0）。
- `e13c2ad16` 不是 main 祖先（`merge-base --is-ancestor` exit 1），且是 L07 分支的 merge main 提交，`--stat` 不含 agent-skills 文件；本包不把它或任何 030 候选当 main。
- 判据：standard-v2 §1.1（`docs/dev/electron-migration/standard-v2.md:32-34`）“被测符号须从 index.ts 的 register/provide 静态到达，找不到生产调用点就不能标 ported”。只读源码，不编译/运行 Rust。源码足以定性，未重复跑测试 suite。
- 下文 TS=`host/plugins/agent-skills/src/tools/skill-workshop-executor.ts`，T=`host/plugins/agent-skills/tests/skill-workshop-executor.test.ts`，R=`src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs`。

### 2. 符号 → 调用 → 注册链

**TS（main）：链在第一环就断。**

1. 被测符号的非测试调用点全部在 TS 内部，最终只汇入 `SkillWorkshopExecutor.propose()`（TS:747）与 `apply()`（TS:1009）。该类没有 `execute(call, ctx)`，只有 `propose/apply/canHandle/sensitivityLevel/name`（TS:747,1009,1188,1193,1198）。
2. 全仓非测试 TS 中 `new SkillWorkshopExecutor` 为 0。`agent-skills/index.ts:226-236` 只 `registerToolExecutors([new PtcToolExecutor(...)])`；其他生产 `registerToolExecutors(` 调用（vfs/notes/memory/browser/chatanki/backup/agent-workspace）都不含 workshop。
3. 导入 `agent-skills/api.ts` 的 22 个非测试文件，逐个检索 13 组被测符号名、`SkillWorkshopExecutor`、`SkillInstallExecutor`，结果为 0（rg exit 1）。`api.ts:214-227` 的 re-export 没有生产消费者。
4. 即使将来登记了这个类，L04 也不会收：`chat/index.ts:124` → `chat/src/service.ts:78` → `chat/src/executor-roster.ts:14` 只收 `typeof executor.execute === 'function'` 的贡献。`host/kernel/agent-roster.ts:63` 列出了 `'SkillWorkshopExecutor'` 名字，缺失时 `:123-124` 抛 `MissingExecutorError`。所以这只是一个名字字符串，没有对应的生产实例。

**共享 helper 排查（没有因“类未注册”就全拒）：**

- `agent-workspace/src/skill-packages.ts:147,179,196,230,262` 有 `normalizePackagePath/validateSkillContent/validatePackageFiles/readPackageDirectory/packageSha256` 的**独立副本**，经 `agent-workspace/src/runtime-roots.ts:22-24,464` 用于生产，**不 import** agent-skills 的同名符号。T:6-12 import 的是 agent-skills 的 TS 版本。所以副本可达不能为本组测试提供资格；它属于另一 owner 的另一份实现。
- `agent-orchestration/src/custom-agent.ts:165-289` 的 `sha256Hex/generateProposalId/validateProposalId/proposalRevisionSha256/readProposalMeta/writeProposalMeta` 是 persona 提案自有实现，同样不是被测符号。
- `POST_WRITE_TRUST_NEXT_STEP`（`skill-install-executor.ts:22`）只被 TS:17,1184 引用；`SkillInstallExecutor` 也没有生产实例。
- Rust 侧真实可达：`src-tauri/src/agent_wiring/roster.rs:105-107` 推入 `SkillWorkshopExecutor::new()`，R:1263-1264 `impl ToolExecutor … execute`。R 的 helper 还被 `skill_lifecycle_executor.rs:412-413` 共享。TS 的 `skill-lifecycle-executor.ts` 不 import workshop helper，且它本身也未注册。

**wiring 工具为什么报 0 未接入：** job `20261105183316-84ff1d`（`node scripts/electron-migration/wiring.mjs --lane agent-skills`）原 exit 0，原文 `合计 ported 323，其中所测模块未从 index.ts 接入 0（0.0%）`。`wiring.mjs:15` 的 IMPORT_RE 把 `import type … from`/`export … from` 都当作边；`agent-skills/index.ts:6-11` 对 `./api.ts` 只有 `import type`，`api.ts:214-223` 又 re-export 整个 TS 模块，于是模块被算作“可达”。这是文件级、含类型边的近似，不是 §1.1 要求的符号级生产调用点。这一假阴性属于工具共性问题，见第 6 节。

### 3. 最早声明提交

- 13 行的 `pending→ported` 全部来自 **`0a3660ecb`**（2026-11-03T08:09-05:00，`feat(agent-skills): port MCP manage executor and workshop cleanup guards`，main 祖先 exit 0）。`git log --all -G` 对 13 个 ID 逐个检索，最早且唯一一次都是它；`git blame -L 323,335 main` 13/13 归属它，此后没有回改。
- 该提交标题和正文只描述 MCP manage 移植与 workshop meta 写入的空 catch 修复，没有提到 workshop 测试映射。TS 测试文件与实现首次出现在 17 分钟前的协调者检查点 `7a37d68db`。
- 同一提交还把 `mcp_manage_executor` 18 行、`mcp_propose_executor` 14 行改为 ported。本包没有审这 32 行（超范围），只记为线索：LANE.md:413 记录这些执行器的 `execute()` 包装也未移植。

### 4. 逐行资格表

“断言”列是 Rust `assert*` 数 ↔ TS `expect` 数，以及逐条对应情况。“资格”只按 §1.1 判定。

| TESTMAP 行 | Rust 原 ID（R 行） | TS 用例（T 行） | 被测 TS 符号（TS 行）→ 生产内部调用 | 断言 | 资格 |
|---|---|---|---|---|---|
| 323 | validate_skill_id_rejects_invalid_chars（1350） | T:45 | validateWorkshopSkillId（438）→ skillIdArg 686、apply 1028 | 5↔5 等价 | 不通过 |
| 324 | validate_content_requires_frontmatter_and_size（1359） | T:53 | validateContent（240）→ validatePackageFiles 287、packageFilesFromArgs 337 | 5↔5 等价 | 不通过 |
| 325 | validate_proposal_id_rejects_path_injection（1370） | T:61 | validateProposalId（426）→ reject 916、apply 1013 | 3↔3 等价 | 不通过 |
| 326 | generate_proposal_id_matches_expected_pattern（1377） | T:67 | generateProposalId（415）→ propose 775、842 | 4↔4；TS `split('_')` 比 `splitn(3)` 更严 | 不通过 |
| 327 | sha256_hex_is_deterministic（1387） | T:76 | sha256Hex（144）→ 203、390、776、818、843、1066 | 2↔2 等价 | 不通过 |
| 328 | approved_proposal_hash_and_revision_reject_post_approval_tampering（1395） | T:83 | verifyApprovedProposal（369）/proposalRevisionSha256（171）→ apply 1047 | 4↔4 等价（见第 5 节样本 A） | 不通过 |
| 329 | approval_hash_fields_require_full_sha256（1458） | T:106 | normalizeWorkshopSha256（148）→ apply 1018、1023 | 2↔2 等价 | 不通过 |
| 330 | workshop_content_uses_the_package_risk_model（1468） | T:114 | workshopRisk（449）→ 783、853、1052 | 4↔4 等价 | 不通过 |
| 331 | write_proposal_files_creates_missing_directories（1483） | T:125 | writeProposalFiles（616）/readProposalMeta（463）→ propose 784、854 | 6↔6，边界较弱（见第 5 节样本 B） | 不通过 |
| 332 | package_validation_accepts_resources_and_rejects_path_attacks（1526） | T:188 | validatePackageFiles（255）→ 333、366、646、667、828 | 1+5 循环 ↔ 1+5 循环，等价 | 不通过 |
| 333 | package_validation_rejects_case_folded_duplicates（1567） | T:214 | validatePackageFiles（255） | 1↔1 等价 | 不通过 |
| 334 | proposal_reader_rejects_symlink_substitution（1581） | T:223 | readProposalPackage（641）→ apply 1046 | 1↔1；Rust `#[cfg(unix)]`，TS 无平台门 | 不通过 |
| 335 | apply_success_narrative_routes_through_skill_trust_request（1620） | T:237 | APPLY_SUCCESS_MESSAGE（27）、POST_WRITE_TRUST_NEXT_STEP（install:22）→ 只在 apply 1183-1184 | 8↔8 等价（见第 5 节样本 C） | 不通过 |

没有“证据不足”项：13 行共享同一条断链，每个符号的全部非测试调用点都已列出，终点都是同一个未注册且无 `execute` 的类。

### 5. 逐 assert 抽样（3/13）

**样本 A，328 行，批准后篡改（R:1395-1455 ↔ T:83-104）：**

| Rust | TS | 对应 |
|---|---|---|
| 1415 `verify(meta, reviewed…).is_ok()` | 89 `.not.toThrow()` | 同输入，同为成功 |
| 1431-1432 改 body，`expect_err` + contains `SKILL.md changed after approval` | 94-95 `.toThrow('SKILL.md changed after approval')` | 子串相同；TS:391-395 的文案与 R:425-429 逐字一致 |
| 1434-1443 同时改 meta.content_sha256，contains `Proposal changed after approval` | 97-99 同 | revision 先于 hash 检查（R:406-412 ↔ TS:375-381），顺序一致 |
| 1445-1454 改 skill_id，contains 同上 | 101-103 同 | 同上 |

`proposalRevisionSha256`（TS:171-185）的长度前缀、u64 LE 与 files 加 previous_files 的顺序与 R:158-191 一致。原测试测的是真实校验函数，不是字符串叙述；等价成立，缺的只是生产可达。

**样本 B，331 行，提案写入建目录（R:1483-1523 ↔ T:125-145）：**

- 6 条逐一对应：`!dir.exists()`↔128；`result.is_ok()`↔138 `toBeUndefined()`（TS 抛错即失败，语义相同）；SKILL.md 与 PROPOSAL.json 存在↔139-140；回读 proposal_id/status↔143-144。
- 边界较弱：Rust 注释写明“proposals_root 与 proposal_dir 都尚不存在”（R:1489-1490），而 T:126 的 `tempDir()` 已用 `mkdtempSync` 创建 root，只有一层缺失。实现 TS:622 是 `mkdirSync(dir, { recursive: true })`，行为上能覆盖两层，但测试没有复现原 P1 回归的两层场景。补到 root 也不存在不需要改实现。
- 实现差异（与本测试断言无关，记为建议）：R:606-611 把 create/write/fsync 分成 `Failed to create|write|fsync proposal file` 三种文案；TS:630-636 合并成 `Failed to write proposal file`。

**样本 C，335 行，apply 成功叙述（R:1620-1630 ↔ T:237-247）：** 8 条 contains/!contains 逐条相同，常量文本与 R:38-39、`skill_install_executor.rs:40-41` 相同。原 Rust 测试本身也只断言常量字符串，没有经过 `execute_apply`；Rust 的生产落点是 R:1256 `"message": APPLY_SUCCESS_MESSAGE`。TS 对应落点 TS:1183-1184 在未注册的 `apply()` 内。所以这一行等价但同样不可达，不能因为它是“纯字符串测试”就豁免 §1.1。

### 6. 给 C2 的撤回清单与后续

- **精确撤回行集：** `host/plugins/agent-skills/TESTMAP.md:323-335`，13 行的去向列从 `ported:host/plugins/agent-skills/tests/skill-workshop-executor.test.ts` 改回 `pending`。原声明是 `0a3660ecb` 的 TESTMAP diff 中含 `skill_workshop_executor.rs::tests::` 的 13 条 `+` 行。**不要 revert 整个 `0a3660ecb`**：它还含 MCP 32 行映射，以及 `skill-workshop-executor.ts` 三处空 catch 改为告警的修复（当时用 console.warn，现 main 为 logger，位于 TS:588,599,608），后者是有效改动。
- 测试文件与断言保留。等 L07 提供带 `execute(call, ctx)` 的 workshop 执行器（含 R:1264-1302 的 end 事件、ToolResultInfo、save_tool_block 包装），并在 `index.ts` 经 `registerToolExecutors` 注册、被 `executor-roster.ts:14` 收录后，这 13 行可凭本节的断言对照恢复为 ported，不必重写断言。按 R1 硬规则，本包不改 TESTMAP，也不 revert。
- 恢复前建议补上两项：T:125 让 root 也不存在；T:223 按 Rust 加平台条件（`skipIf(win32)`，写明原因）。
- 撤回后计数：agent-skills TESTMAP 实际行 ported 323→310、pending 28→41（本包未改，前后仍是 323/28）。
- **工具共性问题（给 C1/C2）：** `wiring.mjs` 按文件、且含 `import type`/barrel re-export 计算可达，会把“只经 api.ts 再导出、无生产调用”的模块判为已接入。所有插件只要 index.ts `import type` 了自家 api.ts，就会出现同类假阴性。建议忽略 type-only import，并对被测符号做符号级的非测试引用检查。

### 7. 本包运行记录

| 检查 | job id | 原 exit | 结果 |
|---|---|---:|---|
| wiring（定位假阴性） | 20261105183316-84ff1d | 0 | `合计 ported 323，其中所测模块未从 index.ts 接入 0（0.0%）` |

没有跑 vitest：13 行的结论来自源码断链，测试绿不改变 §1.1 判定。本包只改本 audit 与 `host/plugins/agent-skills/ACCEPTANCE.md`。

## WP-C2-VERIFY-015 — workshop WP-146 真实接线独立复核（2026-11-06）

**结论：生产接线（候选 `d55b46f9e`）对照 Rust `skill_workshop_executor.rs:1263-1342` 通过；但它不在 main，main 上 VERIFY-010 的断链结论仍成立。13 个 ID 维持 `pending`，接线进 main 前不能恢复资格；进 main 后也只有 11 行可直接恢复，331、334 两行要先补测试。** rawJSON 预算截断残差已用 probe 复现，owner 是 F1 kernel，目前没有生产消费方。

### 0. 固定对象与祖先

- 审读对象固定为 `d55b46f9ea8d647bd10473552f06bb15ef3661aa`，只用 `git show <sha>:<path>` 读取，没有动活 L07 树。`c5b7c5819`、`b471c1e33` 都是它的祖先（exit 0）。`git diff --quiet d55b46f9e 9afedc5ed -- host/plugins/agent-skills` 为 0，即 L07 当前 tip 在本插件目录内与审读对象相同。
- **候选不在 main：** `merge-base --is-ancestor d55b46f9e main` 在 main `1defd30af` 和 `8925b74c0` 上都是 exit 1。C2 撤回提交 `4f5c83b1c` 已在 main（exit 0）。因此下文的“通过”都只针对候选，**不签“main 已闭合”**。
- 候选里 `host/kernel/agent-api.ts`、`chat/src/executor-registry.ts`、`chat/src/execution-context.ts`、`chat/repository/blocks.ts` 与 main `8925b74c0` 的 diff 为空，所以 L04 和 kernel 的结论在 main 上同样适用。

### 1. profile → agentTools → L04 registry.execute → 生产实例（逐项）

TW=`host/plugins/agent-skills/src/tools/skill-workshop-tool-executor.ts`（@d55b46f9e），WS=`…/skill-workshop-executor.ts`（@d55b46f9e），REG=`host/plugins/chat/src/executor-registry.ts`，R=Rust `skill_workshop_executor.rs`。

| 项 | 结论 | TS 证据 | Rust 对照 |
|---|---|---|---|
| 生产实例与登记 | 通过（候选） | `agent-skills/index.ts:228,238` 在 `registerToolExecutors` 中 `new SkillWorkshopToolExecutor({files, appDataDir: ctx.paths.appDataDir, settings: ctx.settings, logger})`；`chat/index.ts:124` 经 `toolExecutors()` 交给 `executor-roster.ts:14`，该类有 `execute`，会被收录 | `pipeline/roster.rs:72`、`agent_wiring/roster.rs:105-107` |
| roster 位置 | 通过 | `kernel/agent-roster.ts` 中 `SkillWorkshopExecutor` 位于 `SkillMarketInstallToolExecutor` 之后、`SkillLifecycleExecutor` 之前 | `pipeline/roster.rs:69-76` 顺序相同 |
| 名称/路由 | 通过 | TW:63-64 → WS `SKILL_WORKSHOP_EXECUTOR_NAME`、`canHandleSkillWorkshopTool`（strip namespace） | R:1325-1330、1340-1342 |
| `mcp_` 前缀路由 | 通过 | REG:56-59 对外部 MCP 名先转 GeneralToolExecutor | Rust `executor_registry.rs:217-222` 同序；所以 `mcp_skill_workshop_apply` 在两边都不会到 workshop。wiring 测试 :42 只断言 `canHandle`，与 Rust `can_handle` 一致 |
| sensitivity | 通过 | TW:65；REG:63/67 未覆写 `sensitivityLevelForCall` 时回落到 `sensitivityLevel` | R:1332-1338；trait 默认 `executor.rs:75-77` |
| concurrency/取消/预算默认 | 通过 | TW 不定义 `concurrencyClass/managesCancellation/resultCharBudget`，REG:78/100/133 分别回落 `serial`、`false`、`30000` | `dstu-agent-api/src/executor.rs:85-101` 默认 Serial/false/Some(30000)，workshop 未覆写 |
| 取消 | 通过（含一处调度差异） | REG:92-95 先检查取消，REG:124-131 race 父 token | Rust `executor_registry.rs:263-270,359-387`。差异：Rust `execute_apply` 在 `spawn_blocking(...).await`（R:1172-1181）有一个可被 select 取消的窗口；TS 的 propose/apply 全程同步，没有 await，取消只能在 execute 之前或之后被看见。TS 的结果集合是 Rust 的子集，不产生新的可观测结果，判为调度差异，不是缺陷 |
| start→end/error 事件 | 通过 | TW:81 start；TW:117 end `{result, durationMs}`；TW:123 error | R:1271、1282-1285、1302 |
| ToolResultInfo | 通过 | 成功 TW:118-121；失败 TW:124-127 `output: null, error` | `dstu-core/src/agent.rs:185-228` success/failure，失败时 `output: Value::Null` |
| duration | 通过 | TW:79,112 `Math.trunc(performance.now()-start)` 单调 | R:1278 `elapsed().as_millis() as u64` 截断 |
| 保存失败 warn | 通过 | TW:129-132 文案 `[SkillWorkshopExecutor] Failed to save tool block: …`，仍返回 result；chat_v2_db 为空时 `execution-context.ts:99-102` 只 warn 不抛 | R:1294-1296、1313-1315 |
| 上下文映射 | 通过 | `proposalsRoot` 解析时先 `windowRef()`，再 `paths.appDataDir/skill_proposals`（TW:87-91；`platform/paths/api.ts:60-61` 注明等于 Tauri `app_data_dir()`）；provenance 走 F4 `settings.*WithConn(main_db)`（TW:67-76），没有自写 settings 表 | R:446-454、999-1043 |

**WP-146 测试的覆盖边界（不影响上表判定）：**
- `tests/skill-workshop-production-wiring.test.ts:55` 用 `createExecutorRegistry([contribution])`，只放了这一个 contribution，不是完整 App roster。完整 roster `assembleExecutorRegistry` 仍会抛 `MissingExecutorError`（:48-52）。:48-52 的 try/catch 在不抛异常时不做任何断言，是弱断言，记为建议。
- L03 真实 tool loop 仍未消费：`chat-pipeline/src/tool-round.ts:48,369` 的 `ToolExecutionPorts.execute` 在非测试代码中没有实现（`git grep ToolExecutionPorts` 只有接口与类内引用）。因此“生产接线可收”的含义只是：L07 已登记、L04 registry 能执行。真实对话中的工具调用路径仍属 B1。
- wiring 测试没有专门覆盖取消；取消由 REG 统一处理，workshop 不自管，源码足以判定，没有新增测试。

### 2. 无窗口 panic 与缺 action 的先后

| 项 | 结论 | 证据 |
|---|---|---|
| propose：action 校验先于 proposals_root | 通过 | WS:794-800 先 `typeof action !== 'string'` 抛错，然后 `this.proposalsRoot()`；R:938-944 同序 |
| apply：参数校验先于 proposals_root | 通过 | WS:1056-1077 依次校验 proposal_id → content sha → revision → skill_id，然后 `proposalDir(this.proposalsRoot(), …)`；R:1045-1079 同序，文案逐条相同 |
| 无窗口等价于 panic | 通过 | TW:88-89 只在 `windowRef()` 抛错时记下 `panic`，TW:109 原样重抛：只有 start 事件，没有 error 事件，不落块。这与 Rust `window_ref()` 在 R:448 panic 时不经过 R:1300-1318 的行为相同。`proposalsRoot()` 在 WS 中只在 :800 与 :1077 调用，都没有 try 包裹，不会把 panic 吞成普通 failure |
| 其他构造期副作用 | 通过 | TW:92 `files.expandPath` 在 start 之后同步执行，但 `files.ts:131-135` 不会抛错，与 Rust `expand_path` 不可失败一致；`provenanceStore` 构造不访问 DB |
| 上游对 panic 的处理 | 不在本包范围 | TS 上游 `tool-round.ts:370-375` 会把 reject 转成 error 事件和 failure；Rust 中 panic 会沿 tokio 任务展开。这属于 L03 的语义，且 L03 尚未消费，只记录 |

### 3. u64 原文 → ToolResultInfo → 事件/保存路径与 rawJSON 预算残差

- **输入：** 实际能产生超过 2^53 数值的只有持久化文件里的 `packageVersion`。PROPOSAL.json 的 map 形式或 WP-030 序列形式，以及 marker 序列形式，经 `exactUnsigned`（WS:43-45）保留为 bigint；propose_update 做饱和 +1（WS:896）。`files[].size` 受 `MAX_PACKAGE_FILE_BYTES=8MiB`（WS:34,273）限制，实际不会超过 2^53。正常流程从 1 递增，要触发必须篡改磁盘上的 marker 或 PROPOSAL.json，wiring 测试 :105、:131-132 正是这样构造的。
- **投影：** TW:43-50 把 bigint 转成原生 `JSON.rawJSON` 原子，只用于 `ToolResultInfo.output` 和 end 事件的 result。之后：`repository/blocks.ts` 的 `jsonParam` 用 `JSON.stringify` 写出原数字；kernel `events.ts:132` 遇到 raw 原子时生成 `payloadJson`（F1-RAWJSON-02，`kernel/API.md:77-84`）。两条路径与 serde_json 的 u64 原文一致，wiring 测试 :110、:114、:124、:137 有断言。**通过。**
- **预算残差（不通过，owner F1 kernel）：** REG:133-134 在 execute 返回后调用 `applyToolResultBudget`（`host/kernel/agent-api.ts:156-172`）。未超预算时原样返回（:158，引用不变），不受影响。超过 30000 字符时，:163 的 `Object.entries` 会把 raw 原子 `{rawJSON:"1844…"}` 当成普通对象重建，原子身份丢失。随后不论走 :170 的对象分支还是 :172 的 preview 分支，序列化结果都是 `"package_version":{"rawJSON":"18446744073709551615"}`。Rust `budget.rs:71-133` 在同样输入下输出数字 `18446744073709551615`。
  - 复现条件：输出中含 >2^53 的 package_version，且序列化后超过 30000 字符。实际可行的输入例如 `list` 返回 2 个各带 256 个文件清单的 pending 提案（约 62k 字符），或单个大清单的 propose_update/apply。
  - 影响范围：event 和 `tool_output_json` 在预算之前已经写出（TW:117、129），不受影响。受影响的只有 registry 的返回值，也就是将来回喂 LLM 和末轮持久化的那份副本。L03 尚未消费（见第 1 节），所以目前是潜在问题。
  - 修复方向（不在本包、不改 kernel）：`truncate` 在 `JSON.isRawJSON(value)` 时按标量原样返回。
- `serializedCharLen`（:155）对 raw 原子用 `JSON.stringify`，计数与 serde 一致，没有问题。

### 4. 13 个 ID：WP-146 后的可达性与资格

两条链，**A=候选链**：`index.ts:238` → `toolExecutors()` → `executor-roster.ts:14` / `createExecutorRegistry` → REG:110 `executor.execute` → TW:105 `workshop.propose` / TW:106 `workshop.apply`。**main 链**：仍是 VERIFY-010 第 2 节的断链（main 没有 TW）。

| TESTMAP 行 | 被测 TS 符号（WS@d55 行） | 候选内生产调用点（WS 行）→ 入口 | 候选可达 | main 可达 | 恢复资格 |
|---|---|---|---|---|---|
| 323 | validateWorkshopSkillId 441 | skillIdArg 728 → proposeCreate/Update 813/853；apply 1075 | 是 | 否 | 进 main 后可恢复 |
| 324 | validateContent 243 | validatePackageFiles 290 → packageFilesFromArgs 336/340 → 815/855 | 是 | 否 | 进 main 后可恢复 |
| 325 | validateProposalId 429 | reject 963、apply 1060 | 是 | 否 | 进 main 后可恢复 |
| 326 | generateProposalId 418 | 823、890 | 是 | 否 | 进 main 后可恢复 |
| 327 | sha256Hex 147 | 206、393、824、866、891、1113 | 是 | 否 | 进 main 后可恢复 |
| 328 | verifyApprovedProposal 372 / proposalRevisionSha256 174 | apply 1094；838、908、947 | 是 | 否 | 进 main 后可恢复 |
| 329 | normalizeWorkshopSha256 151 | apply 1065、1070 | 是 | 否 | 进 main 后可恢复 |
| 330 | workshopRisk 452 | 831、901、1099 | 是 | 否 | 进 main 后可恢复 |
| 331 | writeProposalFiles 658 / readProposalMeta 466 | 832、902；718、933、966、1080 | 是 | 否 | **先补 fixture 才能恢复**（见 5.1） |
| 332 | validatePackageFiles 258 | 336、369、688、709、876 | 是 | 否 | 进 main 后可恢复 |
| 333 | validatePackageFiles 258 | 同上 | 是 | 否 | 进 main 后可恢复 |
| 334 | readProposalPackage 683 | apply 1093 | 是 | 否 | **先补平台条件才能恢复**（见 5.2） |
| 335 | APPLY_SUCCESS_MESSAGE 27 / POST_WRITE_TRUST_NEXT_STEP（install:17 引入） | apply 1230-1231 | 是 | 否 | 进 main 后可恢复 |

**区分：** 生产接线可收，仅指候选 `d55b46f9e` 已满足 standard-v2 §1.1 的“从 index.ts register 静态到达”。13 行的资格判定针对 main，main 不含该接线，所以本包**不重标 ported**。@d55b46f9e 的 TESTMAP:323-335 也仍是 `pending`。候选进 main 并核对祖先后，C2 可以凭 VERIFY-010 第 4-5 节的断言对照，把 11 行恢复为 ported；331、334 两行要先按 5.1、5.2 补测试。

### 5. 独立验证的原断言（2 条，必选两条）

**5.1 行 331 `write_proposal_files_creates_missing_directories`（R:1483-1523 ↔ `tests/skill-workshop-executor.test.ts:125-145`@d55）：结论“目录 fixture 弱于 Rust”成立。**
- Rust R:1485-1489 的 root 是 `temp_dir().join("ds_workshop_test_{pid}_{nanos}")`，没有创建；R:1489 注释写明“proposals_root 与 proposal_dir 都尚不存在”。
- TS :126 用 `tempDir()`，即 :16-19 的 `fs.mkdtempSync`，root **已存在**，只缺 proposal_dir 一层。
- 实现 WS:664 `mkdirSync(dir, { recursive: true })` 能处理两层，所以实现没错，只是测试没有复现原 P1 场景。另外 Rust `files: Vec::new()`，TS `reviewedMeta` 是 `files: []`（:38），两者一致。6 条断言逐一对应，与 VERIFY-010 相同。
- 恢复前需要 L07 在测试中把 root 改为一个不存在的子路径，例如 `path.join(tempDir(), 'missing-root')`，不必改实现。

**5.2 行 334 `proposal_reader_rejects_symlink_substitution`（R:1580-1617 ↔ T:226-238@d55）：结论“缺 Unix 条件”成立；断言本身等价。**
- Rust R:1580 是 `#[cfg(unix)]`，并用 `std::os::unix::fs::symlink`。TS :226 没有平台条件，:231 在所有平台都调用 `fs.symlinkSync`。在 Windows 无权限的环境下，测试会在 arrange 阶段因 EPERM 失败，而不是到达被测断言。在开发者模式下，测试会运行 Rust 本不运行的用例。
- 断言是否测到同一原因：两边都是 `is_err` / `toThrow()`，没有校验文案。对照源码，WS:695-700 与 R:629-636 都在 lstat/symlink_metadata 发现 symlink 后抛 `Proposal file '…' must be a regular non-symlink file`。如果去掉这个检查，读到的是合法 SKILL.md 正文，`validatePackageFiles` 会通过，测试会失败。所以这条用例确实约束了 symlink 分支，没有被其他错误偶然满足。
- 恢复前需要 L07 加上与 Rust 一致的平台条件，并写明原因；若规范不允许 skipIf，请协调者裁定写法。顺带建议用 `toThrow('must be a regular non-symlink file')` 收紧断言，这是建议，不是资格条件。

### 6. 运行证据（与源码证据分开）

| 来源 | job id | 原 exit | 原文摘要 |
|---|---|---:|---|
| WP-146 Node 全目录（复用，未重跑） | 20261105185758-990e39 | 0 | `RUN v3.2.7 /home/dsdev/dev/ds-mig/L07-agent-skills-ptc`；`✓ …skill-workshop-production-wiring.test.ts (1 test) 51148ms`；`Test Files 36 passed (36)`，`Tests 477 passed (477)`；日志中没有 `Errors` 或 `Unhandled` 行 |
| WP-146 Electron-Node 全目录（复用） | 20261105185907-c69c15 | 0 | 命令 `npm run test:host:electron -- host/plugins/agent-skills --maxWorkers=1`；wiring 测试 61010ms；`Tests 477 passed (477)`；没有 `Errors` 行 |
| WP-146 去登记反证（复用） | 20261105184109-335851 | 1 | `AssertionError: expected [] to have a length of 1 but got +0`，位于 `39| expect(contributions).toHaveLength(1)` |
| 本包 rawJSON 预算 probe | 20261105193329-c32047 | 0 | 私有树 `/tmp/opencode/p015`（`git archive d55b46f9e host/kernel host/platform/util`）；`atom isRawJSON true entries [["rawJSON","18446744073709551615"]]`；within budget：`same ref true`、`budgeted has digits true`；`list of 2 x 256-file proposals`：`original chars 62411`、`budgeted keys truncated,original_chars,budget_chars,truncation_note,preview`、`budgeted has digits false`、`budgeted has rawJSON object true`，摘录 `\"package_version\":{\"rawJSON\":\"18446744073709551615\"}` |

- 复用的两个 477 回执，作业开始时间（18:57:58Z、18:59:18Z）都在 `d55b46f9e` 提交时间（18:57:44Z）之后、合并 `9afedc5ed` 之前。由于 `d55b46f9e` 与 `9afedc5ed` 的 agent-skills 目录相同，回执对应的就是审读对象。但 job 记录只有 cwd，没有 sha，这一点只能按时间推定。
- 新测试的 `240_000` 只是这一新增入口自己的时限，没有改动任何旧测试的时限。它不能证明 Rust 原有的 13 条测试已经等价；等价依据仍是 VERIFY-010 第 4-5 节和本节第 5 节的逐条断言对照。
- 本包没有新增测试，没有改 TESTMAP/ACCEPTANCE/业务代码/kernel，没有跑 Rust。

### 7. 给协调者的待办

1. L07：`d55b46f9e` 合入 main 后，C2 核对祖先，即 `merge-base --is-ancestor d55b46f9e main` 为 0，再恢复 11 行。
2. L07：补 331 的两层缺失 fixture、334 的 Unix 平台条件，之后再恢复这两行。
3. F1 kernel：`agent-api.ts:160-165` 的 `truncate` 要把 `JSON.isRawJSON` 值当作标量，并补一个超预算且含 raw 原子的回归测试。L03 接入 registry 前完成即可。
4. 建议：wiring 测试 :48-52 在不抛 `MissingExecutorError` 时也要有断言。

### 8. 补充（协调者指令 1）：正式交付 tip `9afedc5ed`

- **祖先：** `9afedc5ed` 的父提交为 `d55b46f9e` 和 main `1defd30af`，两者都是它的祖先（exit 0）。`9afedc5ed` 不是当前 main `cfac8a04e` 的祖先（exit 1），所以仍然**不签“main 已闭合”**。
- **与已审对象等价：** `git diff --stat d55b46f9e 9afedc5ed` 共 15 个文件，全部来自 main merge。限定到 `host/plugins/agent-skills`、`host/plugins/chat`、`host/kernel/{agent-api,agent-roster,events}.ts`、`host/platform/paths` 后，diff 为空。第 1–5 节的源码结论原样适用于 `9afedc5ed`，不必重审。
- **gate 原件（复用，未重跑）：** typecheck 20261105191515-8dad70、boundaries 20261105191515-d90f7a、boundaries-strict 20261105191515-5cc6cd、importable 20261105191515-a0c28e、tests 20261105191515-71a8f2，原 exit 都是 0。tests 日志：`RUN v3.2.7 /home/dsdev/dev/ds-mig/L07-agent-skills-ptc`，`Test Files 36 passed (36)`，`Tests 477 passed (477)`，wiring 测试 48458ms，没有 `Errors` 行。作业开始时间 19:25:00Z 晚于 tip 提交时间 19:14:59Z。
- **TESTMAP：** @9afedc5ed 共 41 行 pending，323–335 共 13 行 pending；`git diff 1defd30af 9afedc5ed -- TESTMAP.md` 为空。
- **最终区分：**
  1. **接线可收（候选）：** `9afedc5ed` 的 L07 登记和 execute 包装通过（第 1–2 节）。合入 main 并核对祖先后，可以关闭 B4 的生产接线缺口。
  2. **旧 fixture 资格残差：** 13 行维持 pending。合入 main 后，11 行可凭 VERIFY-010 的断言对照恢复。331（根目录 fixture）和 334（Unix 平台条件）须先由 L07 补测试，才能恢复。
  3. **预算 rawJSON 残差：** 已由 C1 派给 182/F1（kernel `agent-api.ts:160–165`），L07 不复制预算实现，也不把它作为 L07 的验收条件。第 3 节的 probe 20261105193329-c32047 可作为 F1 的复现样本。
