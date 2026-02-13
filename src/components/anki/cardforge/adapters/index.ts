/**
 * CardForge 2.0 - Adapters 适配器模块统一导出
 *
 * 提供与其他模块集成的适配器
 */

// Chat V2 适配器
export {
  ChatV2AnkiAdapter,
  useChatV2Anki,
  chatV2CardToCardForgeCard,
  cardForgeCardToChatV2Card,
  type ChatV2AnkiCard,
} from './chatV2Adapter';

// 默认导出 Chat V2 适配器
export { default } from './chatV2Adapter';
