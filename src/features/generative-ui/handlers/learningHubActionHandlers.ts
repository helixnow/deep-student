/**
 * Learning Hub 场景 action handlers — 复用 workbenchBus 确定性路由。
 * 后续可在此扩展 enterFolder / openResource 等 Hub 专属 action。
 */

export {
  createWorkbenchLearningHandlers as createLearningHubActionHandlers,
  workbenchLearningHandlers as learningHubActionHandlers,
} from './workbenchLearningHandlers';
