# 同步 fs 调用方与迁移方案

由 `node scripts/portability/sync-fs-plan.mjs --out scripts/portability/SYNC-FS-PLAN.md` 生成；只统计 `host/plugins` 生产代码里对 `node:fs` 同步函数的调用（不含测试与 `equivalence/`）。

## 结论：不提供同步 `ctx.files`

- 移动端的文件后端（OPFS、Capacitor Filesystem）目录操作只有异步接口：OPFS 的同步访问句柄只能在已打开的单个文件上读写，`exists` / `mkdir` / `readDir` / `rm` / `rename` 都必须 `await`；Capacitor 插件只在主线程、只有 Promise 接口。同步接口在移动端只能靠预读缓存伪造，会和实际文件状态不一致。
- 桌面上同步 I/O 阻塞 Host 所在线程，所有插件的请求都会排队。
- 异步 `ctx.files` 两端都有实现：桌面 `host/platform/files/index.ts`，移动端 `host/platform/files/opfs.ts`（`mobile.json` 已装配，与桌面跑同一套一致性用例，含真实浏览器 Worker）。迁到 `ctx.files` 的调用点在移动端可以直接运行。
- 迁到异步的工作量主要在调用链上：148 个文件的调用点在同步函数里，要把这些函数改成 async 并沿调用方加 `await`；只有 15 个文件可以直接替换。已声明仅桌面的插件（如 backup）保留 `node:fs`，不在迁移范围。

## 对应关系

| 同步函数 | 调用点数 | 异步 `ctx.files` 做法 |
|---|---|---|
| `existsSync` | 208 | `exists` |
| `statSync` | 133 | `stat` |
| `mkdirSync` | 108 | `mkdir` |
| `readFileSync` | 91 | `readBytes` / `readText` |
| `lstatSync` | 83 | `stat({ followSymlinks: false })` |
| `closeSync` | 53 | 随流关闭 / `openFile` 句柄的 `close()` |
| `unlinkSync` | 52 | `rm` |
| `renameSync` | 47 | `rename` |
| `rmSync` | 47 | `rm` |
| `readdirSync` | 46 | `readDir` |
| `realpathSync` | 46 | 交给 `ctx.files` 的作用域校验（根目录限定并处理符号链接）；只做比较时用 `files/path.ts` 的 `isWithin` |
| `openSync` | 44 | 顺序读写用 `openRead` / `openWrite` 流；按偏移读写用 `openFile` 定位句柄 |
| `writeFileSync` | 37 | `writeBytes` / `writeText`；需要原子替换用 `writeAtomic` |
| `fsyncSync` | 22 | `writeAtomic`（内部 fsync）/ `openFile` 句柄的 `sync()` |
| `readSync` | 15 | `openRead` 流；按偏移读用 `openFile` 句柄的 `read(position, length)` |
| `writeSync` | 11 | `openWrite` 流；按偏移写用 `openFile` 句柄的 `write(data, position)` |
| `fstatSync` | 7 | `stat`（按路径）；只要本句柄写入后的大小用 `openFile` 句柄的 `size` |
| `copyFileSync` | 5 | `copyFile` |
| `chmodSync` | 3 | 仅桌面 |
| `linkSync` | 3 | 仅桌面 |
| `opendirSync` | 2 | `readDir` |
| `rmdirSync` | 2 | `rm` |
| `cpSync` | 1 | `copyFile` 逐个 / `walk` |
| `mkdtempSync` | 1 | `mkdir` + `ctx.crypto.randomUUID()` 命名 |

## 汇总

- 文件 164 个，调用点 1067 个。
- 全部在 async 函数里（直接换 `await`）：15 个文件；需要把同步 helper 改成 async：148 个；有模块加载期调用：1 个。

## 逐文件方案

### agent-orchestration（3 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `agent-orchestration/index.ts` | `existsSync`×1 | 同步函数 `superSessionStartup`(L705) 改为 async，调用方加 `await` |
| `agent-orchestration/repository/legacy.ts` | `existsSync`×2 `renameSync`×1 | 同步函数 `migrateLegacyDb`(L7) 改为 async，调用方加 `await` |
| `agent-orchestration/src/custom-agent.ts` | `existsSync`×12 `lstatSync`×3 `mkdirSync`×3 `openSync`×1 `writeSync`×1 `fsyncSync`×1 `closeSync`×1 `renameSync`×3 `unlinkSync`×2 `rmSync`×1 `readFileSync`×3 `readdirSync`×3 | 同步函数 `resolvePersonaPath`(L72)、`writeProposalMeta 内的回调`(L292)、`atomicWrite 内的回调`(L351)、`atomicWrite`(L351)、`readUtf8 内的回调`(L380)、`writeProposal 内的回调`(L460)、`countPendingProposals`(L467)、`countPendingProposals 内的回调`(L467)、`executeList`(L482)、`executeList 内的回调`(L482)、`executeGet`(L518)、`writeProposalDraft`(L540)、`executeProposeList`(L595)、`executeProposeList 内的回调`(L595)、`executeProposeReject`(L620)、`executeApply 内的回调`(L652)、`executeRemove 内的回调`(L733) 改为 async，调用方加 `await` |

### agent-skills（11 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `agent-skills/src/files.ts` | `statSync`×1 `existsSync`×13 `realpathSync`×4 | 同步函数 `metadata`(L88)、`canonicalizeViaExistingAncestor`(L103)、`exists`(L160)、`validatePath`(L164)、`canonicalizeSkillPackageRoot`(L191)、`validateExistingFile`(L264) 改为 async，调用方加 `await` |
| `agent-skills/src/skill-market.ts` | `readdirSync`×1 `statSync`×1 `rmSync`×2 `mkdirSync`×1 `writeFileSync`×1 `realpathSync`×2 `lstatSync`×1 `readFileSync`×1 | 同步函数 `cleanupStaleTempArtifacts`(L358)、`writeTempZip`(L385)、`dispose`(L409)、`readBoundTempZip`(L416) 改为 async，调用方加 `await` |
| `agent-skills/src/skill-package.ts` | `lstatSync`×2 `rmSync`×2 `openSync`×3 `fsyncSync`×3 `closeSync`×3 `readdirSync`×1 `mkdirSync`×5 `readFileSync`×3 `writeSync`×2 `chmodSync`×1 `statSync`×1 `existsSync`×7 `renameSync`×9 | 同步函数 `removePathIfExists`(L409)、`syncDirectory`(L420)、`visit`(L427)、`copySkillDirectoryToStaging`(L454)、`_rollbackInner`(L504)、`isSymlink`(L548)、`create`(L571)、`writeFile`(L605)、`_commitInner`(L630) 改为 async，调用方加 `await` |
| `agent-skills/src/skill-replay.ts` | `statSync`×1 `readFileSync`×1 `existsSync`×1 `mkdirSync`×1 `renameSync`×1 | 同步函数 `isFile`(L484)、`readInstalledLineage`(L496)、`retireLearnedSkill`(L669) 改为 async，调用方加 `await` |
| `agent-skills/src/skill-taps.ts` | `readdirSync`×1 `existsSync`×1 `statSync`×1 `readFileSync`×2 | 同步函数 `visit`(L256)、`buildTapExportArchive`(L277) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/mcp-content-materializer.ts` | `mkdirSync`×2 `realpathSync`×2 `openSync`×1 `writeFileSync`×1 `fsyncSync`×1 `closeSync`×2 `lstatSync`×1 | 同步函数 `writeMaterializedFile`(L318)、`ensureSafeDirectory`(L399) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/object-pages.ts` | `realpathSync`×5 `statSync`×2 `readFileSync`×2 `rmSync`×1 `mkdirSync`×2 `existsSync`×1 `openSync`×1 `writeSync`×1 `fsyncSync`×1 `closeSync`×1 `renameSync`×1 | 同步函数 `readTaskObjectPage`(L72)、`removeTmpQuietly`(L159)、`writeTaskObjectPage`(L170) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/ptc-executor.ts` | `mkdirSync`×1 `openSync`×1 `writeSync`×1 `fsyncSync`×1 `closeSync`×1 `renameSync`×1 `rmSync`×1 | 同步函数 `materializeResultToDir`(L144)、`removeQuietly`(L179) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/skill-workshop-executor.ts` | `existsSync`×7 `readFileSync`×3 `readdirSync`×1 `statSync`×1 | 同步函数 `proposeUpdate`(L205)、`list`(L278)、`reject`(L312)、`apply`(L408) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/skill-workshop-package.ts` | `lstatSync`×1 `readdirSync`×1 `readFileSync`×1 | 同步函数 `readPackageDirectory`(L233)、`walk`(L239) 改为 async，调用方加 `await` |
| `agent-skills/src/tools/skill-workshop-proposals.ts` | `readFileSync`×3 `mkdirSync`×3 `existsSync`×2 `openSync`×2 `writeFileSync`×2 `fsyncSync`×2 `closeSync`×2 `renameSync`×3 `rmSync`×2 `lstatSync`×1 `readdirSync`×1 | 同步函数 `readProposalMeta`(L164)、`writeProposalMeta`(L296)、`writeProposalFiles`(L356)、`readProposalPackage`(L381)、`countPendingProposals`(L410) 改为 async，调用方加 `await` |

### agent-workspace（25 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `agent-workspace/index.ts` | `existsSync`×2 | 同步函数 `apply 内的回调`(L71) 改为 async，调用方加 `await` |
| `agent-workspace/src/approval-scope/env.ts` | `statSync`×2 `existsSync`×1 | 同步函数 `trustedMacosDeveloperDir`(L172)、`buildEnvPlan`(L216) 改为 async，调用方加 `await` |
| `agent-workspace/src/approval-scope/shell-guard.ts` | `existsSync`×1 | 同步函数 `canonicalizePathWithMissingTail`(L458) 改为 async，调用方加 `await` |
| `agent-workspace/src/file-write.ts` | `writeSync`×1 | 同步函数 `writeAll`(L4) 改为 async，调用方加 `await` |
| `agent-workspace/src/runtime-paths.ts` | `lstatSync`×4 `mkdirSync`×3 `existsSync`×2 `renameSync`×1 `rmSync`×1 `unlinkSync`×3 `statSync`×3 `opendirSync`×1 | 同步函数 `optionalMetadata`(L13)、`resolveSessionRuntimeRoot 内的回调`(L40)、`resolveSessionRuntimeRoot`(L40)、`cleanupSessionRuntimeRoots 内的回调`(L92)、`canonicalizeExistingDir 内的回调`(L120)、`listRuntimeDirectoryPage`(L192)、`listRuntimeDirectoryPage 内的回调`(L192)、`removeArtifactFile 内的回调`(L222) 改为 async，调用方加 `await` |
| `agent-workspace/src/runtime-root-approval.ts` | `statSync`×1 | 同步函数 `shellRuntimeApprovalBinding`(L15) 改为 async，调用方加 `await` |
| `agent-workspace/src/runtime-roots.ts` | `statSync`×5 `lstatSync`×2 `readFileSync`×1 `existsSync`×1 `readSync`×1 `fstatSync`×2 `closeSync`×2 `openSync`×1 | 同步函数 `runtimeRootIdentity`(L111)、`resolveStagedFileInTempRoot`(L241)、`size`(L254)、`read`(L254)、`isDirectoryPath`(L257)、`hostCwdRuntimeRoot`(L265)、`resolveRuntimeTarget`(L597)、`read`(L674)、`size`(L675)、`close`(L676)、`openRegularFile`(L693) 改为 async，调用方加 `await` |
| `agent-workspace/src/skill-packages.ts` | `existsSync`×5 `statSync`×1 `readdirSync`×1 `readFileSync`×1 | 同步函数 `validateSkillPath`(L97)、`canonicalizeSkillPackageRoot`(L127)、`readPackageDirectory`(L230)、`walk`(L233) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/code-navigation.ts` | `lstatSync`×2 `readdirSync`×1 `readFileSync`×2 `statSync`×2 | 同步函数 `resolveExistingPath`(L138)、`symbolOutline`(L369) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/file-manager.ts` | `mkdirSync`×1 `existsSync`×4 `renameSync`×3 | 同步函数 `ensureParent`(L178)、`commitItem`(L193)、`fileManagerRestore`(L277) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/file-manager/files.ts` | `lstatSync`×2 `statSync`×1 `existsSync`×3 `openSync`×2 `readSync`×1 `closeSync`×2 `readFileSync`×1 `writeFileSync`×1 `fsyncSync`×1 `renameSync`×1 `rmSync`×1 | 同步函数 `existingRegularFile`(L56)、`checkDestinationAncestors`(L81)、`checkDestinationAncestors 内的回调`(L81)、`hashFile`(L101)、`validateRequestedItem`(L169)、`convertContent`(L287)、`atomicCreate`(L300) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/lsp-navigation.ts` | `statSync`×2 `readFileSync`×1 | 同步函数 `isFile`(L242) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-env.ts` | `statSync`×2 | 同步函数 `trustedMacosDeveloperDir`(L200)、`buildEnvPlanWithInheritDefault`(L215) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-execute/context.ts` | `existsSync`×8 `statSync`×3 | 同步函数 `resolveCwd`(L128)、`protectExistingRoots`(L171)、`addRuntimeReadRoots`(L187)、`isDirectory`(L231)、`buildSandboxPolicy`(L241) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-execute/snapshots.ts` | `readdirSync`×1 `lstatSync`×1 `readFileSync`×1 | 同步函数 `collectFileSnapshot`(L24) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-preflight.ts` | `statSync`×7 `existsSync`×2 | 同步函数 `isRegularFile`(L184)、`platformSandboxCapability`(L253)、`unsandboxedShellCapability`(L284)、`inspectCwd`(L439) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-sandbox-windows.ts` | `statSync`×2 `lstatSync`×4 `mkdirSync`×1 `readdirSync`×1 `unlinkSync`×4 `openSync`×1 `writeFileSync`×1 `fsyncSync`×1 `closeSync`×1 `readFileSync`×1 | 同步函数 `isFile`(L45)、`exists`(L53)、`validateWindowsSandboxPayload`(L117)、`payloadRoot`(L180)、`cleanupStalePayloads`(L203)、`cleanupWindowsPayloadFile`(L241)、`writeWindowsPayload`(L284)、`readWindowsPayload`(L366) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/shell-sandbox.ts` | `statSync`×8 `readdirSync`×1 `lstatSync`×1 `unlinkSync`×2 `openSync`×1 `writeFileSync`×1 `fsyncSync`×1 `closeSync`×1 | 同步函数 `isFile`(L141)、`isDirectory`(L149)、`exists`(L157)、`cleanupStaleProfileFiles`(L172)、`writeProfileFile`(L205)、`cleanupProfileFile`(L241)、`gitGlobalConfigReadRules`(L281)、`capability`(L348)、`capability`(L614)、`windowsCapability`(L728)、`capability`(L746) 改为 async，调用方加 `await` |
| `agent-workspace/src/tools/workspace-fs.ts` | `openSync`×3 `linkSync`×1 `writeFileSync`×1 `readFileSync`×1 `fsyncSync`×3 `closeSync`×4 `unlinkSync`×4 `lstatSync`×6 `mkdirSync`×1 `opendirSync`×1 `statSync`×2 `renameSync`×1 | 同步函数 `stageFile`(L274)、`persistNoClobber`(L287)、`ensureNoSymlinkComponents`(L388)、`ensureWriteTarget`(L423)、`listDirectoryBounded`(L575)、`atomicWriteBytes 内的回调`(L633)、`atomicWriteBytes`(L633) 改为 async，调用方加 `await` |
| `agent-workspace/src/vfs-resolver/exam.ts` | `readFileSync`×1 | 同步函数 `readBlobBytes`(L278) 改为 async，调用方加 `await` |
| `agent-workspace/src/vfs-resolver/pdf.ts` | `readFileSync`×1 | 同步函数 `readBlobBytes`(L130) 改为 async，调用方加 `await` |
| `agent-workspace/src/workspace-change-set.ts` | `lstatSync`×8 `mkdirSync`×3 `openSync`×3 `linkSync`×1 `writeFileSync`×1 `readFileSync`×1 `fsyncSync`×2 `closeSync`×3 `unlinkSync`×7 `renameSync`×2 `statSync`×1 | 同步函数 `canonicalRoot 内的回调`(L89)、`ensureRealParent`(L100)、`ensureRealParent 内的回调`(L100)、`openRegularNoFollow 内的回调`(L132)、`stageFile`(L173)、`persistNoClobber`(L184)、`atomicWrite 内的回调`(L210)、`atomicWrite`(L210)、`checkpointDir 内的回调`(L231)、`checkpointDir`(L231)、`rollback 内的回调`(L320)、`rollback`(L320)、`moveRegularFile`(L366)、`writeBytes`(L385)、`moveFile`(L426)、`deleteFile 内的回调`(L452) 改为 async，调用方加 `await` |
| `agent-workspace/src/workspace/custom-agents.ts` | `statSync`×3 `readFileSync`×2 `readdirSync`×1 | 同步函数 `profileFromFile`(L177)、`isFile`(L243)、`definitionFiles`(L254)、`listCustomAgentFiles 内的回调`(L346) 改为 async，调用方加 `await` |
| `agent-workspace/src/workspace/database.ts` | `existsSync`×4 `mkdirSync`×1 `renameSync`×2 | 同步函数 `openDeletionJournal`(L44)、`create`(L94)、`deleteDatabase`(L227) 改为 async，调用方加 `await` |
| `agent-workspace/src/write-backups.ts` | `openSync`×3 `linkSync`×1 `readFileSync`×1 `writeFileSync`×1 `fsyncSync`×4 `closeSync`×6 `unlinkSync`×6 `lstatSync`×7 `mkdirSync`×2 `renameSync`×1 | 同步函数 `stageFile`(L38)、`persistNoClobber`(L52)、`ensureWriteBackupDir 内的回调`(L78)、`ensureWriteBackupDir`(L78)、`createWriteBackupFromReader 内的回调`(L95)、`createWriteBackupFromReader`(L95)、`resolveWriteBackupSource 内的回调`(L160)、`artifactTargetWithParent 内的回调`(L206)、`verifyRegularArtifactHash 内的回调`(L223)、`atomicCopyToTarget 内的回调`(L238)、`atomicCopyToTarget`(L238)、`restoreArtifactFromBackup`(L290)、`removeArtifactFile 内的回调`(L318) 改为 async，调用方加 `await` |

### anki（9 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `anki/repository/chatanki-vfs.ts` | `readFileSync`×1 | 同步函数 `readVfsBlob`(L159) 改为 async，调用方加 `await` |
| `anki/src/anki-sync.ts` | `statSync`×2 `readFileSync`×1 | 同步函数 `readMediaFileBase64`(L280) 改为 async，调用方加 `await` |
| `anki/src/apkg-exporter.ts` | `statSync`×2 `readFileSync`×3 `mkdirSync`×2 `writeFileSync`×1 `renameSync`×1 `rmSync`×1 | 同步函数 `collectMediaEntries`(L357)、`writeZipFile`(L412)、`createTempDir`(L422)、`cleanupTempDir`(L430)、`writeExport`(L471)、`exportMultiTemplateApkgReport`(L590) 改为 async，调用方加 `await` |
| `anki/src/apkg-import-archive.ts` | `readFileSync`×2 `mkdirSync`×2 `lstatSync`×1 `writeFileSync`×3 `rmSync`×2 | 同步函数 `mediaFilesHaveEqualContents`(L213)、`extractDeclaredMedia`(L224)、`parseArchive`(L457)、`writeTemporaryCollection`(L699) 改为 async，调用方加 `await` |
| `anki/src/apkg-importer.ts` | `statSync`×1 `readFileSync`×1 | 同步函数 `readPathBytes`(L77) 改为 async，调用方加 `await` |
| `anki/src/chatanki-service-adapters.ts` | `statSync`×2 `readFileSync`×1 | 同步函数 `statFile`(L300)、`isFile`(L308)、`readFile`(L316) 改为 async，调用方加 `await` |
| `anki/src/plugin-handlers-export.ts` | `mkdirSync`×1 `rmSync`×3 `statSync`×2 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `anki/src/plugin.ts` | `mkdirSync`×1 | 同步函数 `downloadsDir`(L124) 改为 async，调用方加 `await` |
| `anki/src/template-service.ts` | `readFileSync`×1 | 同步函数 `readBundledBuiltinTemplates`(L71) 改为 async，调用方加 `await` |

### backup（14 个文件；已声明仅桌面：保留 `node:fs`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `backup/repository/schema-registry.ts` | `existsSync`×1 `statSync`×1 | 同步函数 `aggregateSchemaRegistry`(L72) 改为 async，调用方加 `await` |
| `backup/src/assets.ts` | `realpathSync`×2 | 同步函数 `safeExistingFileUnderRoot`(L242) 改为 async，调用方加 `await` |
| `backup/src/backup-commands.ts` | `existsSync`×9 `statSync`×1 `realpathSync`×1 `mkdirSync`×1 | 同步函数 `getBackupList`(L61)、`checkDiskSpace`(L91) 改为 async，调用方加 `await` |
| `backup/src/backup-manager.ts` | `existsSync`×14 `readdirSync`×5 `statSync`×5 `mkdirSync`×10 `copyFileSync`×1 `lstatSync`×8 `readFileSync`×1 `rmSync`×2 | 同步函数 `listBackups`(L56)、`fileEntry`(L135)、`copyStrict`(L184)、`collectFiles`(L190)、`walk`(L196)、`backupCryptoKeys`(L214)、`safeLstat`(L287)、`validateMasterKey`(L295)、`copy`(L357)、`copyPersistentDirectory`(L352)、`resolveExistingBackupFile`(L641)、`resetRebuildableVfsIndex`(L724) 改为 async，调用方加 `await` |
| `backup/src/crypto-restore.ts` | `lstatSync`×9 `rmSync`×4 `chmodSync`×1 `openSync`×1 `fsyncSync`×1 `closeSync`×1 `copyFileSync`×2 `statSync`×1 `readFileSync`×2 `readdirSync`×3 `existsSync`×9 `mkdirSync`×5 `cpSync`×1 `renameSync`×6 `mkdtempSync`×1 | 同步函数 `removeCryptoPath`(L34)、`restrictPermissions`(L46)、`syncDirectory`(L51)、`copyCryptoFileToStaging`(L57)、`validateStagedMasterKey`(L73)、`collectBackupFilesUnder`(L88)、`walk`(L99)、`snapshotCurrentCryptoKeys`(L165)、`rollbackPublishedCrypto`(L176) 改为 async，调用方加 `await` |
| `backup/src/governance.ts` | `readFileSync`×1 `writeFileSync`×1 `rmSync`×2 `existsSync`×5 `statSync`×2 `mkdirSync`×2 | 同步函数 `readPersistedMigrationError`(L130)、`persistMigrationError`(L341)、`clearPersistedMigrationError`(L347)、`integrityCheck`(L431)、`resetDir`(L524) 改为 async，调用方加 `await` |
| `backup/src/initialization.ts` | `mkdirSync`×4 | 同步函数 `ensureDirectories`(L33)、`initializeAuditLog`(L40) 改为 async，调用方加 `await` |
| `backup/src/jobs.ts` | `existsSync`×3 `mkdirSync`×1 `writeFileSync`×1 `renameSync`×1 `readdirSync`×1 `statSync`×1 `readFileSync`×1 `unlinkSync`×1 | 同步函数 `persistJob`(L184)、`loadPersistedJobs`(L204)、`deletePersistedJob`(L219) 改为 async，调用方加 `await` |
| `backup/src/manifest.ts` | `lstatSync`×3 `readFileSync`×2 `writeFileSync`×1 `renameSync`×1 `unlinkSync`×1 `openSync`×1 `readSync`×1 `closeSync`×1 | 同步函数 `loadManifest`(L760)、`saveManifest`(L772)、`sha256File`(L871)、`sha256FileFull`(L891)、`isSafeExistingRelative`(L943) 改为 async，调用方加 `await` |
| `backup/src/paths.ts` | `realpathSync`×2 `existsSync`×1 `statSync`×1 | 同步函数 `ensureExistingPathWithinBackupDir`(L118)、`databaseFileExists`(L173) 改为 async，调用方加 `await` |
| `backup/src/restore-commands.ts` | `writeFileSync`×2 `renameSync`×1 `existsSync`×6 `readFileSync`×1 `unlinkSync`×3 `realpathSync`×1 `mkdirSync`×2 | 同步函数 `persistRestoreActivationMarker`(L111) 改为 async，调用方加 `await` |
| `backup/src/restore-files.ts` | `mkdirSync`×3 `lstatSync`×2 `openSync`×1 `readSync`×1 `closeSync`×1 `statSync`×1 `copyFileSync`×1 `existsSync`×1 | 同步函数 `prepareBackupRestoreDestination`(L10)、`sha256FileExact`(L45)、`verifyRestoredFile`(L64)、`copyVerified`(L83)、`pathExists`(L97) 改为 async，调用方加 `await` |
| `backup/src/restore-plan.ts` | `existsSync`×2 `mkdirSync`×1 `writeFileSync`×1 `statSync`×1 `lstatSync`×1 `rmSync`×1 `readFileSync`×1 | 同步函数 `restoreAuditDb`(L111)、`restoreAuditDomain`(L131)、`verifyPrimaryOrchestrationDomain`(L192)、`removeStaleVfsLanceDir`(L328)、`readFileText`(L333) 改为 async，调用方加 `await` |
| `backup/src/zip-commands.ts` | `existsSync`×6 `mkdirSync`×4 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |

### browser（4 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `browser/src/bridge.ts` | `readFileSync`×1 | 模块加载期调用（L10）：移到插件 `apply` / 首次使用时异步初始化 |
| `browser/src/browser-service.ts` | `mkdirSync`×1 `unlinkSync`×1 | 同步函数 `finishDownloadHash`(L844) 改为 async，调用方加 `await` |
| `browser/src/browser-tool-executor.ts` | `realpathSync`×1 `statSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `browser/src/download-hash.ts` | `openSync`×1 `readSync`×1 `closeSync`×1 | 同步函数 `hashDownloadFileBoundedCore`(L14) 改为 async，调用方加 `await` |

### chat（5 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `chat/src/agents-md.ts` | `statSync`×2 `existsSync`×1 `realpathSync`×2 `readFileSync`×1 | 同步函数 `isFile`(L29)、`ensureAgentsMdWithinRoot`(L45)、`fileMtime`(L71)、`readAgentsMdFile`(L76) 改为 async，调用方加 `await` |
| `chat/src/attachment-stage.ts` | `openSync`×7 `readSync`×4 `closeSync`×7 `readFileSync`×2 `lstatSync`×1 `fstatSync`×2 `rmSync`×2 `writeFileSync`×2 `writeSync`×1 `mkdirSync`×6 `statSync`×1 | 同步函数 `validateArchiveSignature`(L82)、`scanZipArchive`(L101)、`lstat`(L232)、`loadStageIndex`(L237)、`sha256FileBounded`(L285)、`copyFileBounded`(L317)、`removeIgnoringError`(L357)、`removeDirIgnoringError`(L362)、`writeIgnoringError`(L367)、`writeAll`(L371)、`writeBytesCreateNew`(L376)、`stageIntoTempRoot`(L402)、`createUniqueExtractDir`(L473)、`extractZipIntoTempRoot`(L499)、`resolveVfsAttachment`(L612)、`materializeCorpusManifest`(L733) 改为 async，调用方加 `await` |
| `chat/src/completion-dispatcher.ts` | `existsSync`×1 | 同步函数 `workspaceDbExists`(L268) 改为 async，调用方加 `await` |
| `chat/src/register.ts` | `writeFileSync`×1 | 同步函数 `registerChatCommands 内的回调`(L150) 改为 async，调用方加 `await` |
| `chat/src/workspace-profiles.ts` | `mkdirSync`×1 `existsSync`×3 `readFileSync`×1 `unlinkSync`×1 | 同步函数 `listAgentProfiles`(L14)、`readAgentProfileFile`(L38)、`deleteAgentProfileFile 内的回调`(L48)、`saveAgentProfileFile 内的回调`(L59) 改为 async，调用方加 `await` |

### chat-pipeline（3 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `chat-pipeline/repository/budget.ts` | `statSync`×1 | 同步函数 `readSettingFromMainDb`(L84) 改为 async，调用方加 `await` |
| `chat-pipeline/src/finalizer.ts` | `lstatSync`×1 `realpathSync`×2 `openSync`×1 `readSync`×1 `closeSync`×1 | 同步函数 `resolveUnderRoot`(L93)、`sha256FileHex`(L126) 改为 async，调用方加 `await` |
| `chat-pipeline/src/retrieval-images.ts` | `readFileSync`×1 | 同步函数 `resolveRetrievalPageImages 内的回调`(L250) 改为 async，调用方加 `await` |

### chatanki（2 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `chatanki/src/transform-script-sandbox.ts` | `statSync`×3 `realpathSync`×2 `chmodSync`×1 `mkdirSync`×1 `writeFileSync`×2 | 同步函数 `isExecutableFile`(L46)、`isRegularFile`(L57)、`extraReadableRootsForInterpreter`(L96)、`isDirectory`(L119)、`setPrivateJobPermissions`(L174)、`prepareTransformJob`(L184) 改为 async，调用方加 `await` |
| `chatanki/src/transform-script.ts` | `lstatSync`×1 `openSync`×1 `readSync`×1 `closeSync`×1 | 同步函数 `readOutputFileBounded`(L227) 改为 async，调用方加 `await` |

### llm（3 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `llm/src/audit_log.ts` | `mkdirSync`×1 | 同步函数 `buildDebugPersistConfig`(L25) 改为 async，调用方加 `await` |
| `llm/src/essay_grading/custom_modes.ts` | `existsSync`×2 `readFileSync`×1 `renameSync`×3 `mkdirSync`×1 `writeFileSync`×1 `rmSync`×1 | 同步函数 `loadConfig`(L364)、`backupCorruptedFile`(L396)、`saveConfig`(L408)、`removeSyncIfPresent`(L440) 改为 async，调用方加 `await` |
| `llm/src/ocr_pages_service.ts` | `realpathSync`×2 | 同步函数 `resolveImagePath`(L46) 改为 async，调用方加 `await` |

### mcp（1 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `mcp/src/stdio-validation.ts` | `realpathSync`×2 `statSync`×2 | 同步函数 `canonicalCwd`(L48)、`canonicalExecutable`(L57) 改为 async，调用方加 `await` |

### media（14 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `media/src/bilibili-bridge-server.ts` | `readFileSync`×2 | 同步函数 `pairPage`(L30)、`bridgeScript`(L35) 改为 async，调用方加 `await` |
| `media/src/bilibili-link-items.ts` | `statSync`×1 `readFileSync`×1 | 同步函数 `readLinkDescriptor`(L52) 改为 async，调用方加 `await` |
| `media/src/document-parser.ts` | `statSync`×1 `readFileSync`×1 | 同步函数 `checkPdfEncryptionFromPath`(L528) 改为 async，调用方加 `await` |
| `media/src/exam-sheet-service.ts` | `existsSync`×2 `realpathSync`×1 `rmSync`×1 `mkdirSync`×2 | 同步函数 `resolveImagePath`(L102)、`realPathOrNull`(L135) 改为 async，调用方加 `await` |
| `media/src/figure-extractor.ts` | `readFileSync`×1 | 同步函数 `loadPageImageBytes`(L41) 改为 async，调用方加 `await` |
| `media/src/image-base64.ts` | `realpathSync`×2 `existsSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `media/src/media-library.ts` | `readFileSync`×1 | 同步函数 `coverUrlOf`(L144) 改为 async，调用方加 `await` |
| `media/src/media-transcriber.ts` | `readdirSync`×1 `statSync`×1 `unlinkSync`×1 | 同步函数 `sweepStaleMediaTemp`(L67) 改为 async，调用方加 `await` |
| `media/src/ocr-engine-test.ts` | `mkdirSync`×1 `writeFileSync`×1 `rmSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `media/src/pdfium-utils.ts` | `readdirSync`×1 `statSync`×1 | 同步函数 `pushExistingPdfiumInChildDirs`(L17) 改为 async，调用方加 `await` |
| `media/src/pipeline.ts` | `writeFileSync`×1 `unlinkSync`×1 | 同步函数 `resolveMediaSource`(L72)、`cleanup`(L98) 改为 async，调用方加 `await` |
| `media/src/tools/media-tool-executor.ts` | `statSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `media/src/tools/office-fidelity-executor.ts` | `statSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `media/src/wav.ts` | `mkdirSync`×1 `openSync`×1 `writeSync`×1 `closeSync`×2 `unlinkSync`×2 `readSync`×1 | 同步函数 `constructor`(L30)、`write`(L36)、`close`(L50)、`readMs`(L68)、`close`(L81) 改为 async，调用方加 `await` |

### notes（9 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `notes/repository/assets.ts` | `mkdirSync`×1 `writeFileSync`×1 `existsSync`×3 `readdirSync`×5 `realpathSync`×2 `statSync`×1 `rmdirSync`×1 | 同步函数 `saveNoteAsset`(L69)、`listNoteAssets`(L96)、`resolveAssetPath`(L152)、`walkFiles`(L221)、`isDirectory`(L313)、`collectNoteAssetDeletionEntries`(L327)、`collectNoteAssetDeletionDirsForNotes`(L372)、`removeEmptyAssetDirectory`(L401) 改为 async，调用方加 `await` |
| `notes/repository/export-archive.ts` | `existsSync`×2 `statSync`×2 `mkdirSync`×1 `readFileSync`×1 `writeFileSync`×1 | 同步函数 `collectBundleSnapshot`(L181)、`resolveOutputPath`(L278) 改为 async，调用方加 `await` |
| `notes/repository/import-archive.ts` | `mkdirSync`×1 `writeFileSync`×1 `unlinkSync`×2 `existsSync`×2 `readFileSync`×1 | 同步函数 `writeEntryToDisk`(L231) 改为 async，调用方加 `await` |
| `notes/repository/import.ts` | `readFileSync`×1 | 同步函数 `importMarkdownNote`(L31) 改为 async，调用方加 `await` |
| `notes/repository/stats.ts` | `statSync`×2 `readdirSync`×1 | 同步函数 `notesDbStats`(L17)、`scanAssets`(L42) 改为 async，调用方加 `await` |
| `notes/src/command-utils.ts` | `existsSync`×1 `realpathSync`×1 | 同步函数 `materializeLocalImportPath`(L90) 改为 async，调用方加 `await` |
| `notes/src/import-markdown.ts` | `unlinkSync`×1 | 同步函数 `cleanupMaterializedImportFiles`(L83) 改为 async，调用方加 `await` |
| `notes/src/notes-import-tool.ts` | `lstatSync`×1 | 同步函数 `resolveStagedFileInTempRoot`(L68) 改为 async，调用方加 `await` |
| `notes/src/transfer-commands.ts` | `mkdirSync`×1 `unlinkSync`×2 | 同步函数 `stagingPath`(L38) 改为 async，调用方加 `await` |

### qbank（10 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `qbank/repository/export.ts` | `readFileSync`×1 | 同步函数 `exportPortable`(L257) 改为 async，调用方加 `await` |
| `qbank/src/crop-source-image.ts` | `readFileSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `qbank/src/csv-commands.ts` | `existsSync`×1 `mkdirSync`×2 `unlinkSync`×4 | 同步函数 `removeTemp`(L89)、`removeStaged`(L214) 改为 async，调用方加 `await` |
| `qbank/src/csv-export.ts` | `writeSync`×1 `openSync`×1 `closeSync`×1 `unlinkSync`×1 `statSync`×1 | 同步函数 `writeAll`(L152)、`exportCsv`(L169) 改为 async，调用方加 `await` |
| `qbank/src/csv-import.ts` | `openSync`×1 `readFileSync`×1 `closeSync`×1 | 同步函数 `readFileWithEncoding`(L136) 改为 async，调用方加 `await` |
| `qbank/src/enhanced-statistics.ts` | `existsSync`×1 `readdirSync`×1 `statSync`×2 | 同步函数 `getImageStatistics`(L32) 改为 async，调用方加 `await` |
| `qbank/src/generation-figures.ts` | `readFileSync`×1 | 同步函数 `loadPageImageBytes`(L36) 改为 async，调用方加 `await` |
| `qbank/src/generation-references.ts` | `readFileSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `qbank/src/question-import-legacy-vision.ts` | `readFileSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `qbank/src/source-view-service.ts` | `existsSync`×1 `readFileSync`×1 | 同步函数 `exists`(L18)、`read`(L19) 改为 async，调用方加 `await` |

### sync（22 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `sync/repository/apply-databases.ts` | `existsSync`×1 | 同步函数 `applyDownloadedChangesToDatabases`(L199) 改为 async，调用方加 `await` |
| `sync/repository/blob-file-refs.ts` | `existsSync`×1 | 同步函数 `blobHashesWithLocalRefs`(L8) 改为 async，调用方加 `await` |
| `sync/repository/registry-preflight.ts` | `existsSync`×1 | 同步函数 `validateSyncRegistryDrift`(L73) 改为 async，调用方加 `await` |
| `sync/repository/sync-pass.ts` | `existsSync`×2 | 同步函数 `markUploadedChanges`(L13)、`archiveSyncedChangeLogs`(L46) 改为 async，调用方加 `await` |
| `sync/repository/tombstone.ts` | `statSync`×1 `lstatSync`×3 `readdirSync`×1 | 同步函数 `pathModifiedAfter`(L257)、`validateBlobRelativePath`(L441)、`findBlobByHash`(L486) 改为 async，调用方加 `await` |
| `sync/repository/workspace-files.ts` | `rmSync`×1 | 同步函数 `discard`(L9) 改为 async，调用方加 `await` |
| `sync/src/asset-paths.ts` | `readdirSync`×1 `statSync`×3 `existsSync`×2 `lstatSync`×1 | 同步函数 `symlink`(L63) 改为 async，调用方加 `await` |
| `sync/src/asset-sync.ts` | `mkdirSync`×1 `existsSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `sync/src/blob-sync.ts` | `readdirSync`×1 `statSync`×3 `rmSync`×1 `existsSync`×1 `mkdirSync`×1 | 同步函数 `scanBlobs`(L83)、`size`(L95)、`mtime`(L98)、`discard`(L101) 改为 async，调用方加 `await` |
| `sync/src/collect-sync-changes.ts` | `existsSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `sync/src/conflict-commands.ts` | `existsSync`×1 | 同步函数 `open`(L34) 改为 async，调用方加 `await` |
| `sync/src/deletion-queues.ts` | `existsSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `sync/src/file-tombstone-sync.ts` | `existsSync`×1 `rmSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `sync/src/history-commands.ts` | `existsSync`×3 | 同步函数 `open`(L13)、`listSyncSnapshotBatches`(L20)、`purgeResolvedConflicts`(L53) 改为 async，调用方加 `await` |
| `sync/src/list-commands.ts` | `existsSync`×3 | 同步函数 `open`(L16)、`listQuarantine`(L27)、`listRecordConflicts`(L53) 改为 async，调用方加 `await` |
| `sync/src/local-commands.ts` | `existsSync`×3 | 同步函数 `open`(L13)、`countRecordConflicts`(L19)、`discardAll`(L51) 改为 async，调用方加 `await` |
| `sync/src/prune-gap.ts` | `existsSync`×1 | 全部在 async 函数里：逐个换成 `await ctx.files.*` |
| `sync/src/quarantine-commands.ts` | `existsSync`×2 | 同步函数 `open`(L14) 改为 async，调用方加 `await` |
| `sync/src/status.ts` | `existsSync`×2 | 同步函数 `open`(L12) 改为 async，调用方加 `await` |
| `sync/src/transfer-commands.ts` | `existsSync`×2 `mkdirSync`×1 `openSync`×1 `writeSync`×1 `closeSync`×1 `readFileSync`×1 | 同步函数 `open`(L32)、`collectLocalManifest`(L56)、`writeSyncExportData`(L185)、`flush`(L192)、`readSyncImportData`(L221) 改为 async，调用方加 `await` |
| `sync/src/unsynced-classification.ts` | `existsSync`×2 `readdirSync`×1 | 同步函数 `pathExistsExact`(L87)、`classifyBlobs`(L102) 改为 async，调用方加 `await` |
| `sync/src/workspace-sync.ts` | `rmSync`×3 `statSync`×2 `existsSync`×7 `copyFileSync`×1 `readdirSync`×1 `mkdirSync`×1 | 同步函数 `discard`(L36)、`modified`(L54)、`fileSize`(L58)、`saveConflictCopy`(L62) 改为 async，调用方加 `await` |

### sync-support（1 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `sync-support/src/tombstone-files.ts` | `statSync`×1 `existsSync`×1 `lstatSync`×2 `readdirSync`×1 | 同步函数 `pathModifiedAfter`(L23)、`isSymlink`(L137)、`findBlobByHash`(L146) 改为 async，调用方加 `await` |

### translation（1 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `translation/src/ocr_extract.ts` | `mkdirSync`×2 `writeFileSync`×2 `unlinkSync`×3 | 同步函数 `ensureWritable`(L44) 改为 async，调用方加 `await` |

### vfs（11 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `vfs/repository/create.ts` | `mkdirSync`×1 `statSync`×1 `writeFileSync`×1 `renameSync`×1 | 同步函数 `storeBlobWithConn 内的回调`(L438) 改为 async，调用方加 `await` |
| `vfs/repository/resources.ts` | `readFileSync`×1 | 同步函数 `getFileContentWithConn`(L999) 改为 async，调用方加 `await` |
| `vfs/src/database.ts` | `mkdirSync`×1 | 同步函数 `constructor`(L16) 改为 async，调用方加 `await` |
| `vfs/src/dstu-trash.ts` | `statSync`×3 `realpathSync`×2 `readdirSync`×1 `rmSync`×1 | 同步函数 `cleanupNoteAssetDirs`(L349) 改为 async，调用方加 `await` |
| `vfs/src/exam-formatter.ts` | `readFileSync`×1 | 同步函数 `blobImage`(L37) 改为 async，调用方加 `await` |
| `vfs/src/export.ts` | `existsSync`×2 `readFileSync`×1 `writeFileSync`×2 `rmSync`×1 | 同步函数 `exportTextbook`(L293)、`blobOriginal`(L557)、`payloadBytes`(L889) 改为 async，调用方加 `await` |
| `vfs/src/protocols.ts` | `fstatSync`×2 `statSync`×3 `realpathSync`×5 `openSync`×1 `closeSync`×3 `readSync`×1 | 同步函数 `openedFileMatchesAuthorizedPath`(L296)、`openAuthorizedFile`(L312)、`close`(L322)、`readExact`(L329)、`handleAssetProtocol`(L350)、`filestreamCheckAccess`(L519)、`resolveAllowedDirs`(L535)、`resolveBlobDirs`(L557) 改为 async，调用方加 `await` |
| `vfs/src/tools/dstu-executor.ts` | `lstatSync`×1 `realpathSync`×1 | 同步函数 `uploadFile 内的回调`(L193) 改为 async，调用方加 `await` |
| `vfs/src/tools/mindmap-import.ts` | `statSync`×2 `readFileSync`×1 | 同步函数 `readPath 内的回调`(L36)、`loadBytes`(L41) 改为 async，调用方加 `await` |
| `vfs/src/tools/retrieval-rerank.ts` | `readFileSync`×1 | 同步函数 `vlRerankSources 内的回调`(L57) 改为 async，调用方加 `await` |
| `vfs/src/upload-attachment.ts` | `openSync`×1 `readSync`×1 `closeSync`×1 | 同步函数 `stagedChunks`(L104) 改为 async，调用方加 `await` |

### vfs-handlers（7 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `vfs-handlers/repository/media-cache.ts` | `statSync`×3 `readdirSync`×2 `existsSync`×1 | 同步函数 `directorySize`(L28)、`directorySize 内的回调`(L28)、`mediaCacheStats`(L41)、`mediaCacheStats 内的回调`(L41) 改为 async，调用方加 `await` |
| `vfs-handlers/repository/refs.ts` | `readFileSync`×1 | 同步函数 `readBlobBase64`(L676) 改为 async，调用方加 `await` |
| `vfs-handlers/src/attachments.ts` | `existsSync`×1 `statSync`×1 `readFileSync`×1 | 同步函数 `content 内的回调`(L66) 改为 async，调用方加 `await` |
| `vfs-handlers/src/files.ts` | `readFileSync`×2 | 同步函数 `getFileContent`(L71)、`getBlobBase64`(L98) 改为 async，调用方加 `await` |
| `vfs-handlers/src/filestream.ts` | `realpathSync`×2 `statSync`×1 | 同步函数 `canonicalize`(L29)、`canonicalRoot`(L33)、`checkAccess`(L36) 改为 async，调用方加 `await` |
| `vfs-handlers/src/pdf.ts` | `statSync`×1 `readFileSync`×1 | 同步函数 `readPdfPageImageBytes`(L163) 改为 async，调用方加 `await` |
| `vfs-handlers/src/vector-cache-files.ts` | `statSync`×1 `readdirSync`×1 `lstatSync`×2 `existsSync`×1 `rmdirSync`×1 `rmSync`×1 | 同步函数 `isDirectory`(L6)、`directoryBytes`(L9)、`clearVectorCacheDirectory`(L20) 改为 async，调用方加 `await` |

### vfs-index（4 个文件；非核心：迁到 `ctx.files`，或声明 `platforms: ['desktop']` 后保留）

| 文件 | 调用 | 方案 |
|---|---|---|
| `vfs-index/src/chat-embeddings.ts` | `mkdirSync`×3 | 同步函数 `resolveLancePath`(L258) 改为 async，调用方加 `await` |
| `vfs-index/src/legacy-kb-store.ts` | `mkdirSync`×3 | 同步函数 `resolveKbLancePath`(L279) 改为 async，调用方加 `await` |
| `vfs-index/src/pdf-service.ts` | `mkdirSync`×1 | 同步函数 `ensureMediaTempDir`(L484) 改为 async，调用方加 `await` |
| `vfs-index/src/runtime-adapter.ts` | `mkdirSync`×1 | 同步函数 `resolveVfsLanceBase`(L226) 改为 async，调用方加 `await` |

### vfs-repos（5 个文件；移动端核心：必须迁到 `ctx.files`）

| 文件 | 调用 | 方案 |
|---|---|---|
| `vfs-repos/repository/attachment-utils.ts` | `statSync`×1 | 同步函数 `isFile`(L276) 改为 async，调用方加 `await` |
| `vfs-repos/repository/attachments.ts` | `openSync`×1 `fstatSync`×1 `readSync`×1 `closeSync`×1 `statSync`×2 | 同步函数 `readFileBounded`(L219)、`getContentSource 内的回调`(L430) 改为 async，调用方加 `await` |
| `vfs-repos/repository/blobs.ts` | `rmSync`×6 `writeSync`×1 `readFileSync`×1 `mkdirSync`×2 `writeFileSync`×1 `statSync`×4 `renameSync`×3 `openSync`×1 `closeSync`×1 `existsSync`×3 `readdirSync`×3 | 同步函数 `dispose`(L34)、`writeAll`(L62)、`computeFileHash`(L133)、`stageStream 内的回调`(L147)、`storeSource`(L180)、`removeTemp`(L224)、`prepareBlobDeletion`(L359)、`finishBlobDeletion`(L387)、`removeUnregisteredBlobFile 内的回调`(L446)、`sweepStaleTempFiles`(L484) 改为 async，调用方加 `await` |
| `vfs-repos/repository/files.ts` | `readFileSync`×3 `existsSync`×1 | 同步函数 `getContent 内的回调`(L624) 改为 async，调用方加 `await` |
| `vfs-repos/src/maintenance-service.ts` | `existsSync`×2 `rmSync`×1 | 同步函数 `resetRebuildableIndex`(L75) 改为 async，调用方加 `await` |
