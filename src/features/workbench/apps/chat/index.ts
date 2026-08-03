/**
 * Chat 应用（workbench）公共出口 — P7
 */
export { ChatSessionSurface, type ChatSessionSurfaceProps } from './ChatSessionSurface';
export {
  registerChatApp,
  handleChatActivation,
  chatAppDefinition,
  CHAT_APP_TYPE_ID,
} from './register';
export {
  launchNewChatSession,
  openChatSession,
  type LaunchNewChatSessionOptions,
  type LaunchNewChatSessionResult,
} from './newSession';
