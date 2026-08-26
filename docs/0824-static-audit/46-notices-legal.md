# 46 — NOTICES / legal 分发链路审计（legal/ 权威路径 · tauri resources · vite 中间件）

- 基座：`cursor/0824-cde6`（静态只读审计，不做 Tauri 实机编译）。
- 范围：`THIRD_PARTY_NOTICES.txt` 的权威路径约定（在 `legal/` 而非 `public/legal/`）、Tauri `bundle.resources` 分发、vite dev 中间件代理、前端读取双通道及其守卫脚本/测试。

## 1. 权威路径：`legal/THIRD_PARTY_NOTICES.txt`，public/ 无副本

- 生成脚本把唯一输出写到仓库根 `legal/`，注释明确"不再放 public/（避免随 frontendDist 进安装包形成双份）"：

```13:16:scripts/generate-third-party-notices.mjs
// 唯一权威路径（WI-9 legal 去重）：不再放 public/（避免随 frontendDist 进安装包形成双份），
// 仅经 tauri.conf.json bundle.resources 进入 resources/licenses/；前端展示走
// resolveResource 读取（web dev 由 vite 中间件代理，见 vite.config.ts legalNoticesDevPlugin）。
const outputPath = path.join(repoRoot, 'legal', 'THIRD_PARTY_NOTICES.txt');
```

- 实测 `public/` 目录下无 `legal/` 子目录（仅 icons/wallpapers/pdf.worker.wrapper.mjs 等），全仓 `legal/` 目录只有 `legal/THIRD_PARTY_NOTICES.txt` 一份实体（约 1.25 MB，已提交，未被 .gitignore 排除）。文件头含 Cargo.lock / package-lock.json 双 SHA256（1849 组件、787 份去重文本、3 份公共文本）。
- `docs/THIRD_PARTY_LICENSES.md` 是策略说明文档（非清单副本），首段同样声明 `legal/` 为唯一权威路径，口径一致。

## 2. Tauri resources：进安装包 `resources/licenses/`

```60:69:src-tauri/tauri.conf.json
    "resources": {
      "../LICENSE": "licenses/DeepStudent-AGPL-3.0.txt",
      "../legal/THIRD_PARTY_NOTICES.txt": "licenses/THIRD_PARTY_NOTICES.txt",
      "vendor/lancedb/LICENSE": "licenses/lancedb-Apache-2.0.txt",
      "vendor/object_store/LICENSE.txt": "licenses/object_store-LICENSE.txt",
      "vendor/object_store/NOTICE.txt": "licenses/object_store-NOTICE.txt",
      "vendor/rs-fsrs/LICENSE": "licenses/rs-fsrs-MIT.txt",
      "resources/pdfium/LICENSE.pdfium-binaries": "licenses/pdfium-binaries-MIT.txt",
      "resources/pdfium/licenses/": "licenses/pdfium/"
    },
```

- 前端常量与映射目标一致：`THIRD_PARTY_NOTICES_RESOURCE_PATH = 'licenses/THIRD_PARTY_NOTICES.txt'`（`src/features/settings/components/OpenSourceAcknowledgementsSection.tsx:92`）。
- 读取权限齐备：`src-tauri/capabilities/default.json:53` 与 `capabilities/mobile.json:49` 均含 `fs:allow-resource-read-recursive`，且 fs scope 列出 `$RESOURCE/**`（default.json:73、mobile.json:69）；`tauri.conf.json:44` 的 assetProtocol scope 也含 `$RESOURCE/**`。
- 合规脚本 `scripts/check-license-compliance.mjs:94-108` 硬编码校验上述 8 条 resources 映射逐条存在且源文件在盘上，映射被删/改会直接 fail；`package.json:11` 的 `prebuild` 链上 `licenses:check`，同时校验双 lock SHA256 防止清单过期。

## 3. vite 中间件：dev 代理 + 构建不进 dist

```79:97:vite.config.ts
function legalNoticesDevPlugin(): Plugin {
  return {
    name: "serve-legal-notices-from-repo-root",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/legal/THIRD_PARTY_NOTICES.txt", (_req, res) => {
        const noticesPath = path.join(server.config.root, "legal", "THIRD_PARTY_NOTICES.txt");
        if (!fs.existsSync(noticesPath)) {
          res.statusCode = 404;
          res.end("THIRD_PARTY_NOTICES.txt not generated. Run npm run licenses:generate.");
          return;
        }
        // ...200 + text/plain 返回权威文件...
      });
    },
  };
}
```

- `apply: "serve"` 保证中间件只存在于 dev；build 产物 dist 中不含 NOTICES（唯一进包通道是 §2 的 resources），WI-9 去重目标（1.25 MB 不双份进安装包）成立。
- 未生成时返回 404 并提示 `npm run licenses:generate`，dev 体验有兜底。
- 项目自身 LICENSE 走另一条通道：`vite.config.ts:213` 由 viteStaticCopy 拷为 `dist/legal/DEEPSTUDENT_LICENSE.txt`（该插件 dev 下也提供同路径服务），与 NOTICES 的"只走 resources"策略不同但体积小（AGPL 全文 ~34 KB），且 resources 里另有 `licenses/DeepStudent-AGPL-3.0.txt` 一份。属有意取舍，非缺陷。

## 4. 前端双通道读取与测试覆盖

```104:118:src/features/settings/components/OpenSourceAcknowledgementsSection.tsx
const loadLegalDocumentText = async (document: LegalDocument): Promise<string> => {
  if (document === 'thirdParty' && isTauriRuntime()) {
    try {
      const [{ resolveResource }, { readTextFile }] = await Promise.all([
        import('@tauri-apps/api/path'),
        import('@tauri-apps/plugin-fs'),
      ]);
      return await readTextFile(await resolveResource(THIRD_PARTY_NOTICES_RESOURCE_PATH));
    } catch {
      // 资源读取失败（如旧安装包）时回退 fetch，让统一的错误态处理兜底
    }
  }
  const response = await fetch(LEGAL_DOCUMENT_PATHS[document]);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
};
```

- Tauri 运行时（`__TAURI_INTERNALS__`/`__TAURI_IPC__` 探测，:94-97）走 `resolveResource('licenses/THIRD_PARTY_NOTICES.txt')` + `readTextFile`；纯 web dev 走 `fetch('./legal/THIRD_PARTY_NOTICES.txt')`，命中 §3 中间件。
- 测试锁死两条通道：`tests/vitest/settings/OpenSourceAcknowledgementsSection.test.tsx:143-161`（web fetch 路径断言 `'./legal/THIRD_PARTY_NOTICES.txt'`）与 :163-184（Tauri 路径断言 `resolveResource('licenses/THIRD_PARTY_NOTICES.txt')` 且 fetch 未被调用）。

## 5. 残留观察（均不构成本轮 FAIL/WARN）

1. 打包环境下若 resources 读取失败（如旧安装包升级残留），catch 后回退 fetch 会 404（dist 无该文件）→ 落入统一错误态文案。源码注释已声明这是有意兜底（:112-114），可接受。
2. Android 上 `$RESOURCE` 经 APK assets 解析，本轮无实机编译不验证（符合本审计仓"不做 Tauri 实机编译"约定，见 `docs/0824-static-audit/README.md`）；capabilities/mobile.json 权限已就位，风险留待发布冒烟。
3. `vite preview`（预览 dist）下 NOTICES 会 404——中间件仅 serve 模式生效。该场景非产品分发路径，不要求修复。

## 结论

**PASS**。NOTICES 权威路径确在仓库根 `legal/`（`public/` 下无 `legal/` 目录、无任何副本）；进包唯一通道是 `tauri.conf.json` `bundle.resources`（`../legal/THIRD_PARTY_NOTICES.txt` → `licenses/THIRD_PARTY_NOTICES.txt`），dev 由 `vite.config.ts` `legalNoticesDevPlugin` 按原 fetch 路径代理权威文件；前端 Tauri/web 双通道读取有 vitest 契约锁定，`licenses:check` 在 prebuild 强制校验 resources 映射与 lock 哈希新鲜度。链路自洽、守卫齐全，无需产品修复。**本轮不改代码**。
