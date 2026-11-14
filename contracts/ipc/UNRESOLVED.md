# IPC 契约未确定形状

由 `npm run contracts:generate` 生成（deep-student/node-contracts@1.0.0），勿手改。

以下为 JSON 源中保留的 `x-unresolved` 注解；它们不是待执行的 Rust 构建任务。修改时核对当前 Host 实现。

## L04-chat-session.json

- `/events/4/payload/anyOf/1` — payload type of `payload` not determinable statically

## L10-notes.json

- `/events/4/payload/anyOf/1` — payload type of `event` not determinable statically

## L12-vfs-index.json

- `/events/6/payload/anyOf/1/properties/current` — json! value `done` type not determinable statically
- `/events/6/payload/anyOf/1/properties/total` — json! value `total` type not determinable statically

## L13-vfs-api.json

- `/events/5/payload/anyOf/1/properties/current` — json! value `done` type not determinable statically
- `/events/5/payload/anyOf/1/properties/total` — json! value `total` type not determinable statically

## L19-mcp-browser.json

- `/events/8/payload/anyOf/1/properties/current` — json! value `done` type not determinable statically
- `/events/8/payload/anyOf/1/properties/total` — json! value `total` type not determinable statically
- `/events/11/payload/properties/message` — json! value `payload` type not determinable statically

## L21-backup-governance.json

- `/events/1/payload` — payload type of `snapshot.clone(..)` not determinable statically
