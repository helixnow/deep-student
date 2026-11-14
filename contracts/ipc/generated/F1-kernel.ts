// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/F1-kernel.json
/* eslint-disable */
import type * as Shared from './_shared.ts';

/** deep_student_lib::plugins::events::ActivityPayload */
export type ActivityPayload = {
  pluginId: string;
  kind: string;
  summary: string;
  ts: number;
};
/** deep_student_lib::plugins::types::PluginInfo */
export type PluginInfo = {
  id: string;
  label: string;
  blurb: string;
  kind: PluginKind;
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  error: string | null;
};
/** deep_student_lib::plugins::types::PluginKind */
export type PluginKind = "channel";
/** deep_student_lib::plugins::types::PluginState */
export type PluginState = "stopped" | "starting" | "waiting_login" | "running" | "stopping" | "error";
/** deep_student_lib::plugins::types::PluginStatusSnapshot */
export type PluginStatusSnapshot = {
  state: PluginState;
  enabled: boolean;
  configured: boolean;
  bound: boolean;
  loginStatus: string | null;
  accountId: string | null;
  userId: string | null;
  lastError: string | null;
  lastActivity: string | null;
  qrcodePngBase64: string | null;
  qrcodeStatus: string | null;
};
/** deep_student_lib::plugins::events::QrcodePayload */
export type QrcodePayload = {
  pluginId: string;
  pngBase64: string;
  status: string;
  ts: number;
};
/** deep_student_lib::plugins::events::StateChangedPayload */
export type StateChangedPayload = {
  pluginId: string;
  state: PluginState;
  error: string | null;
  ts: number;
};

export interface Commands {
  /** src/plugins/commands.rs:66 `plugin_begin_login` */
  plugin_begin_login: {
    args: {
      id: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:74 `plugin_cancel_login` */
  plugin_cancel_login: {
    args: {
      id: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:40 `plugin_get_config` */
  plugin_get_config: {
    args: {
      id: string;
    };
    result: unknown;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:32 `plugin_get_status` */
  plugin_get_status: {
    args: {
      id: string;
    };
    result: PluginStatusSnapshot;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:11 `plugin_list` */
  plugin_list: {
    args: Record<string, never>;
    result: PluginInfo[];
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:82 `plugin_logout` */
  plugin_logout: {
    args: {
      id: string;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:48 `plugin_set_config` */
  plugin_set_config: {
    args: {
      id: string;
      patch: unknown;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:57 `plugin_set_enabled` */
  plugin_set_enabled: {
    args: {
      id: string;
      enabled: boolean;
    };
    result: null;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:16 `plugin_start` */
  plugin_start: {
    args: {
      id: string;
    };
    result: PluginState;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:24 `plugin_stop` */
  plugin_stop: {
    args: {
      id: string;
    };
    result: PluginState;
    error: Shared.AppError;
  };
  /** src/plugins/commands.rs:87 `plugin_unbind` */
  plugin_unbind: {
    args: {
      id: string;
    };
    result: null;
    error: Shared.AppError;
  };
}

export interface Events {
  "plugin-activity": ActivityPayload;
  "plugin-qrcode": QrcodePayload;
  "plugin-state-changed": StateChangedPayload;
}

export type CommandName = keyof Commands;
export type PluginBeginLoginCommandArgs = Commands['plugin_begin_login']['args'];
export type PluginBeginLoginCommandResult = Commands['plugin_begin_login']['result'];
export type PluginCancelLoginCommandArgs = Commands['plugin_cancel_login']['args'];
export type PluginCancelLoginCommandResult = Commands['plugin_cancel_login']['result'];
export type PluginGetConfigCommandArgs = Commands['plugin_get_config']['args'];
export type PluginGetConfigCommandResult = Commands['plugin_get_config']['result'];
export type PluginGetStatusCommandArgs = Commands['plugin_get_status']['args'];
export type PluginGetStatusCommandResult = Commands['plugin_get_status']['result'];
export type PluginListCommandArgs = Commands['plugin_list']['args'];
export type PluginListCommandResult = Commands['plugin_list']['result'];
export type PluginLogoutCommandArgs = Commands['plugin_logout']['args'];
export type PluginLogoutCommandResult = Commands['plugin_logout']['result'];
export type PluginSetConfigCommandArgs = Commands['plugin_set_config']['args'];
export type PluginSetConfigCommandResult = Commands['plugin_set_config']['result'];
export type PluginSetEnabledCommandArgs = Commands['plugin_set_enabled']['args'];
export type PluginSetEnabledCommandResult = Commands['plugin_set_enabled']['result'];
export type PluginStartCommandArgs = Commands['plugin_start']['args'];
export type PluginStartCommandResult = Commands['plugin_start']['result'];
export type PluginStopCommandArgs = Commands['plugin_stop']['args'];
export type PluginStopCommandResult = Commands['plugin_stop']['result'];
export type PluginUnbindCommandArgs = Commands['plugin_unbind']['args'];
export type PluginUnbindCommandResult = Commands['plugin_unbind']['result'];
