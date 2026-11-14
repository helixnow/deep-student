# example.web-search

只有 Host 半的社区插件：提供离线搜索服务 `exampleWebSearch`（接口同官方声明的 `WebSearchService`，
`host/plugins/mcp/api.ts`），配置由 Schemastery `Config` 校验。它和官方 `webSearch` 并存，不替换它。

```
community-web-search/
├── package.json        # 清单：engines.deepStudent + deepStudent{manifestVersion,id,platforms,host}
├── index.ts            # Host 半：Config + ctx.provide('exampleWebSearch')
├── user.profile.json   # 用户 profile：extends "official"，再加本插件和它的 config
├── test.profile.json   # 测试：只加载本插件，config 取默认值
└── __tests__/          # 测试与 profile 夹具
```

## 配置

`index.ts` 的 `Config`：

| 字段 | 类型 | 默认值 |
|---|---|---|
| `label` | string | `example-web-search`（写进 `result.provider`、`usage.provider`） |
| `site` | string | `https://example.edu/search` |
| `maxResults` | 0–10 的整数 | `3`（还受请求的 `top_k` 限制） |

Host 在 `apply` 之前校验并补默认值（`host/kernel/plugin-config.ts`）。不合法时插件以
`CONFIG_INVALID: invalid config: …` 降级，其他插件照常装载。schema 里出现凭据字段（`role('secret')`，或
`apiKey`、`token`、`password` 等字段名）会以 `CONFIG_CREDENTIAL` 拒绝装载：profile 是明文 JSON，凭据走密钥服务。

## 为什么不替换官方 webSearch

旧版本示例用官方插件的 id（`dstu.browser`）指向社区模块来整体替换它。v1 清单规则下这条路不通
（`host/kernel/API.md` §16.1、§16.2）：

- profile 条目 id 与包清单 id 不同 → `ID_MISMATCH`。由于同 id 条目会替掉继承来的官方条目，这个 profile
  连官方 browser 插件也没有了（`__tests__/fixtures/override.profile.json`，测试里有断言）；
- 清单 id 写成 `dstu.*` → `ID_RESERVED`（社区来源不能用 `dstu` publisher）；
- 提供不在自己名字空间里的服务（比如 `webSearch`）→ `SERVICE_NAME_INVALID`。

要换一种搜索实现，就提供自己的服务（这里是 `exampleWebSearch`），由需要它的插件显式使用。

## 测试

```bash
DEEP_STUDENT_BUILD_NUMBER=20000 npx vitest run -c examples/vitest.config.ts examples/plugins/community-web-search
```

`__tests__/web-search.test.ts` 用 `__tests__/fixtures/official.profile.json` 代替真实官方 profile（只有官方
browser 插件，它需要的 settings/storage/log/featureFlags 用最小替身），验证：与官方插件并存、配置校验与默认值、
`CONFIG_INVALID`、同 id 替换被拒绝、卸载，以及 UI 清单里没有它的 UI 模块。
