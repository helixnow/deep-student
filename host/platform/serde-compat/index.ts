/**
 * serde-compat（平台纯函数模块，无 Cordis 服务）：产出与 Rust serde_json 字节一致的 JSON。
 *
 * - DB 写入：`toRustJson(value, schema)` 代替 `JSON.stringify(value)`，schema 用 `rs.*` 手写
 *   （引用 Rust 结构体 file:line）或 `fromContractSchema` 取自 contracts/ipc。
 * - IPC 返回值：`toRustValue(value, schema)`（键序、省略键、null、f32 投影）。
 * - 单个数字：`formatF64` / `formatF32` / `formatInt`；手工拼对象时用 `f64Atom` / `f32Atom`
 *   （kernel 原生数字原子，`JSON.stringify` 原样写出）。
 *
 * 详细语义见 ./API.md。
 */
export * from './api.ts';
export { formatF32, formatF64, formatInt, formatValueNumber, f32Atom, f64Atom, isNumberAtom, toInteger } from './number.ts';
export { rs, renameField, renameVariant, type EnumOptions, type StructOptions } from './schema.ts';
export { toRustJson, toRustValue } from './serialize.ts';
export { contractResolver, fromContractSchema, type ContractResolver, type FromContractOptions } from './contract.ts';
