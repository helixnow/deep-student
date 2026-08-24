# 收尾续作 #3：Sidekick Planner / Vlm 生产接线

## 结果

`anki_model_routing` 的四个角色现均有生产消费者：

| 角色 | 生产路径 | 首选槽位 | 降级 |
|---|---|---|---|
| Planner | ChatAnki `plan_route` | 主模型槽 | 缺槽位按路由计划复用基准模型；探测/配置失效回退原 model2 |
| Generator | `StreamingAnkiService::get_configurations` | 制卡槽 | 主模型或视觉槽 |
| Critic | `anki_critic::run_critic_pass` | 主模型槽 | 基准制卡模型或原 model2 |
| Vlm | `vlm_light`、`vlm_full` 及纯图片升级分支的图片提取 | 视觉槽 | 缺槽位复用基准模型；探测/配置失效回退原 model2 |

Planner 与 Vlm 都通过 `resolve_anki_role_decision` 读取当前槽位，再通过
`call_anki_routed_raw_prompt` 执行。没有新增配置、网络调用类型或 UI。

## 失败边界

- Planner 槽调用失败时重试接线前的 model2；仍失败则 `plan_route` 返回 `None`，
  调用方继续使用确定性启发式路由，制卡不中断。
- Vlm 槽调用失败时携带同一批图片重试接线前的 model2 图片提取路径。
- 槽位探测失败返回空决策；配置在探测后消失由路由适配器回退 model2。
- 只有路由模型与原 model2 业务调用都失败时，才保留接线前已有的模型错误语义；
  Sidekick 路由本身不会新增失败点。

## 测试

`anki_model_routing` 共 25 个单元测试；本续作新增 8 个：

- 原有 17 个覆盖模式解析、四角色选槽、缺槽位降级、单模型模式、序列化、
  槽位探测和探测到计划的端到端纯逻辑。
- 新增 6 个 Planner/Vlm 降级矩阵测试，覆盖仅主模型、主模型兼任视觉、
  缺制卡槽、缺主槽、同配置多槽去重，以及 single + 仅视觉槽。
- 新增 2 个生产接线契约测试，锁定 Planner/Vlm 角色、可回退调用适配器、
  Planner 启发式降级，以及三条 VLM extract 调用路径。

验证命令：

```bash
cargo test --lib anki_model_routing:: -- --test-threads=8
cargo check --lib
```
