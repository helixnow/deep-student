/**
 * Chat 应用（workbench）公共出口 — P7
 */
export { ChatSessionSurface, type ChatSessionSurfaceProps } from './ChatSessionSurface';
export {
  registerChatApp,
  handleChatActivation,
  handleChatSessionActivation,
  chatAppDefinition,
  chatSessionAppDefinition,
  CHAT_APP_TYPE_ID,
  CHAT_SESSION_APP_TYPE_ID,
} from './register';
export {
  launchNewChatSession,
  openChatSession,
  openChatSessionInNewWindow,
  type LaunchNewChatSessionOptions,
  type LaunchNewChatSessionResult,
} from './newSession';
