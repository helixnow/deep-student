# A 产出的 L21 种子素材（W21）

`l21-backups-mixed-v1`、`l21-backups-legacy-mirror-v1`、`l21-historical-zip-v1` 三个种子的原料必须由 A（Tauri+Rust 参考构建）自己产出：一份完整备份目录、一个便携 ZIP、一个密封 ZIP。本目录放产出脚本和冻结后的产物；种子构造在 `../a-produced-seeds.ts`，规则见 `host/plugins/backup/equivalence/README.md` §4.1、§4.4、§10.5。

| 文件 | 来源 | 说明 |
|---|---|---|
| `producers.v0.json` | W21 | producer 套件（不在 `equivalence/` 下，G3 语料扫描不会收它）：`w21.a-produce.full-backup` 跑一次完整备份；`w21.a-produce.historical-zips` 导出便携/密封 ZIP 到 `/tmp/w21-a-produced/`。每个后台任务后用全局锁栅栏（删除不存在的备份）等它结束，再读 `get_backup_job` |
| `collect.ts` | W21 | 把 g3-run-a 的产出冻结成下面三项；校验两个场景的任务都是 `completed`、备份恰好一份 |
| `PROVENANCE.json` | 服务器产出 | `w21-a-produced/v1`：A 构建回执 sha256/job/binarySha256/submittedRevision/rustSourceTree、producer 套件 sha256 与 tree commit、每个文件的 size/sha256、翻转字节位置、ZIP 密码、A 自己写的审计行与审计种子编码核对结果 `audit.mismatches` |
| `full-backup/**.gz` | 服务器产出 | 备份目录逐文件 gzip（种子构造时解压并按 PROVENANCE 校验 sha256） |
| `historical-zip/{portable,sealed}.zip.gz` | 服务器产出 | 两个 ZIP，gzip 包一层（`*.zip` 在 `.gitignore` 里） |

`PROVENANCE.json` 不存在、`take` 不是 A1/A2 或带 `localCheck` 时，三个种子都不进 `SEED_NAMES`，引用它们的场景在语料检查里是 `unknown-seed`，录制器按 unsupported 跳过。

## 服务器步骤（主代理执行；W21 不连服务器）

沿用 `host/e2e/differential/SERVER-COMMANDS.md` 的 S0 变量（`$TREE`、`$SHA`、`$NODE`、`$OPS`、`$REPORTS`、`$RECEIPT`、`$DSENV`）。前提：`$TREE` 是 S1 冻结的录制树，且包含本目录（W21 分支已进落地分支）。放在 S2 之后、S8 之前，约 5 分钟，与 S5 不冲突（不占 batch worker）。

```bash
# W21-A1. A 跑 producer 套件（不加 --compact：要保留 run/ 里的备份目录）
P=$OPS/w21-a-produced-${SHA:0:12}
rm -rf /tmp/w21-a-produced && sudo -u dsdev mkdir -p /tmp/w21-a-produced
cd $TREE && sudo -u dsdev $DSENV xvfb-run -a dbus-run-session -- $NODE scripts/electron-migration/record/g3-run-a.mjs \
  host/e2e/data-compat/__fixtures__/a-produced/producers.v0.json $RECEIPT $P/run --take A1 2>&1 | sudo -u dsdev tee $P.log
# 判定：两行 "status":"recorded"；full-backup 的 outcomes 是 result,error,result,result，historical-zips 是 result,error,result,result,error,result

# W21-A2. 冻结（必须在清 /tmp/w21-a-produced 之前）
cd $TREE && sudo -u dsdev $DSENV $NODE host/e2e/data-compat/__fixtures__/a-produced/collect.ts \
  --run $P/run --receipt $RECEIPT --out $P/fixture
# 判定：输出 JSON 的 seeds 有 3 个、zips 有 portable/sealed、auditShapeMismatches 为 []；
# 非空说明 audit-seeds.ts 的构造编码与 A 不一致，产物照常收，把这一行交给 W21。
du -sh $P/fixture                                        # 预期 1MB 以内，collect.ts 上限 32MiB
sudo -u dsdev mkdir -p $REPORTS/w21-a-produced-${SHA:0:12} && sudo -u dsdev cp -rp $P/fixture/. $REPORTS/w21-a-produced-${SHA:0:12}/
```

失败处理：`collect.ts` 报 `job ended "failed"` 时，错误文案在 `$P/run/<场景>/A1/trace.json` 对应 `get_backup_job` 的 `outcome.raw`；报 `no .db file with an unallocated byte on page 1` 说明 A 备份里没有可翻转的库，交 W21 改选翻转位置。不要用 B 的产出代替。

## 落库（主代理，本地）

```bash
D=host/e2e/data-compat/__fixtures__/a-produced
cp -R <从 $REPORTS/w21-a-produced-<sha12>/ 取回的目录>/. $D/
DEEP_STUDENT_BUILD_NUMBER=20000 bin/heavy npx vitest run -c vitest.host.config.ts \
  host/e2e/data-compat/g3-a-produced-seeds.test.ts host/e2e/data-compat/g3-audit-seeds.test.ts --maxWorkers=2
# g3-audit-seeds 的 "constructed encoding matches the audit rows A wrote" 这时不再 skip，必须通过
git mv host/plugins/backup/equivalence/pending-seed/inventory-mixed-seeded.json host/plugins/backup/equivalence/inventory-mixed-seeded.json
git mv host/plugins/backup/equivalence/pending-seed/verify-with-assets-seeded.json host/plugins/backup/equivalence/verify-with-assets-seeded.json
git add $D && git commit -m "[W21] a-produced: freeze A backup/ZIP artifacts (<sha12>), enable mixed/legacy-mirror suites"
node scripts/electron-migration/record/g3-corpus-check.mjs   # unknown-seed 少 5（mixed ×2、legacy、historical ×2）
```

`pending-seed/historical-zip.json` 还要等录制器支持 `${seed.*}`（W13，`seedBindings()` 已给出取值），先留在 pending。

## 进 S8

落库提交进落地分支后重做 S1/S2，跑一次 S4/S6：`inventory-mixed-seeded.json`、`verify-with-assets-seeded.json` 的 3 个场景会出现在 `a-store-coverage.json` 的 `missing`，与其它补录场景一起由 S8 `--top-up-from` 录进增补 store，不需要单独一轮。

## 换历史提交

`l21-historical-zip-v1` 默认用当前 A 参考构建的 ZIP。若 C1 指定某个历史提交，用 wp043 构建该提交拿到它自己的回执，把上面两步的 `$RECEIPT` 换成该回执重跑；`PROVENANCE.json` 会记下 `submittedRevision`，种子代码不变。三个种子共用一份 PROVENANCE，所以那次也会同时换掉 mixed/legacy 的备份原料。

## 本地自检（不提交产物）

用 B 跑同一套件可以演练整条流水线：

```bash
mkdir -p /tmp/w21-a-produced
NODE_DISABLE_COMPILE_CACHE=1 node scripts/electron-migration/record/g3-run-b.mjs host/e2e/data-compat/__fixtures__/a-produced/producers.v0.json /tmp/w21-b-run
node host/e2e/data-compat/__fixtures__/a-produced/collect.ts --run /tmp/w21-b-run --out /tmp/w21-b-fixture --take B --local-check
```

`--local-check` 的产物带 `localCheck: true`、`a: null`，`availableAProducedSeeds()` 永远不提供它；测试里用 `writeAProducedSeed(..., { allowLocalCheck: true })` 读。`NODE_DISABLE_COMPILE_CACHE=1` 绕开录制器快照与 Node 编译缓存临时文件的竞态（交 W13）。
