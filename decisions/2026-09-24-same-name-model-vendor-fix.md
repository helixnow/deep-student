# 同名模型跨供应商固定 Bug 修复

日期：2026-09-24
状态：已分析，待实施

## 问题

全局设置中切换对话默认模型后，如果新旧默认是**不同供应商的同名模型**（如 SiliconFlow 的 `Qwen/Qwen3-8B` vs DashScope 的 `Qwen3-8B`），对话界面仍显示旧供应商的版本。异名模型无此问题。

## 根因

`InputBarV2.tsx` 中 `matchesModelIdentity()` 按**名称模糊匹配**而非仅按 config ID 精确匹配：

```typescript
// candidates = [modelId, modelDisplayName]
// modelId 为空（未固定会话），modelDisplayName = "Qwen/Qwen3-8B"
matchesModelIdentity(model, [modelId, modelDisplayName])
// → model.model === "Qwen/Qwen3-8B" 匹配 SiliconFlow 版本
// → Array.find() 返回第一个匹配项（排在前面的供应商获胜）
```

`availableModels` 列表来自 `fetchAvailableModelInfos()`，不排序，顺序取决于后端返回。同名模型的 `model.model` 或 `model.name` 可能相同，`find()` 返回排在前面的那个。

## 修复方案

### A. `matchesModelIdentity` 优先按 config ID 精确匹配

当 candidates 中包含非空 config ID 时，只按 `model.id` 匹配，不再回退到名称模糊匹配。

### B. InputBarV2 未固定会话从全局默认取生效 config ID

未固定会话（`modelIdPinnedByUser !== true`）显示当前模型时，不依赖 `chatParams.modelDisplayName` 做模糊匹配，而是从 `model_assignments.model2_config_id` 获取当前生效的 config ID，再按 ID 精确查找。

## 影响范围

- `InputBarV2.tsx`: `matchesModelIdentity` + `currentModelInfo` 计算
- 新增测试文件覆盖同名模型场景
