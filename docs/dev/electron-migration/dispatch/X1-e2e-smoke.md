# X1-e2e-smoke：整机冒烟（生产链路）

目标：证明"迁移后的 Host 作为一个整体能在真实 Electron 里起来并响应前端调用"，而不是各插件只在各自测试宿主里能跑。

## 交付（只写 `host/e2e/smoke/` 与 `docs/dev/electron-migration/audits/X1-e2e-smoke.md`）
1. **整机启动测试**：用生产 profile（`host/profiles/` 下桌面 profile 的生成方式，见 F1 的 profile 生成器）和**隔离的临时数据目录**（绝不触碰真实用户数据），在 Node 与 Electron（`ELECTRON_RUN_AS_NODE=1`，见 `npm run test:host:electron`）两种运行时加载全部插件，断言：所有插件 apply 成功、`plugin:host|status`（或内核等价接口）无降级插件、每个插件声明的 `provides` 服务都已注册。失败时输出"哪个插件因缺哪个服务没起来"的清单。
2. **命令覆盖探针**：对 `contracts/ipc/*.json` 中每条已注册命令，用契约生成**最小合法参数**调用一次，记录：成功 / 业务错误（AppError 形状正确即算通过）/ 崩溃（未捕获异常、返回值违反契约、Promise 永不 settle——加超时）。崩溃即失败。产出按 lane 分组的问题表。
3. 不修复别的 lane 的代码：问题写进审计报告，按归属 lane 分组，附复现命令与最小参数；协调者会分发。
4. 测试要能在集成门禁里跑（时长控制在 3 分钟内；慢的部分用环境变量开关）。

完成后贴出：启动结果、命令探针统计（总数 / 成功 / 业务错误 / 崩溃）、按 lane 的问题清单。
