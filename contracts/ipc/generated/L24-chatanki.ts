// 自动生成，勿手改：npm run contracts:generate
// 生成器：deep-student/node-contracts@1.0.0；来源：contracts/ipc/L24-chatanki.json
/* eslint-disable */


export interface Commands {
}

export interface Events {
  "fsrs://changed": ({
    source: string;
    action: string;
    entityIds: string[];
    runId: string;
  } | unknown);
}

export type CommandName = keyof Commands;
