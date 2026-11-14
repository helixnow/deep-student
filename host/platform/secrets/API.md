# secrets：流式备份加解密（给 W08 sync-providers / backup）

`ctx.secrets.backup`（api.ts `BackupCrypto`）和 `createFileCipherSession` 返回的 `FileCipherSession` 都有一组
Web Streams 入口，字节格式与错误文案和路径版（`encryptBackupFile` / `decryptBackupFile`、
`encryptFile` / `decryptFile`）完全相同，只是读写端换成流。移动端没有任意路径的 `node:fs`，用 `ctx.files.openRead`
/ `openWrite` 拿到的流直接喂进来，就不必依赖 `node:fs/promises`、`node:os` 的临时目录。

```ts
backup.encryptBackupStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, password: string): Promise<void>;
backup.decryptBackupStream(input: ReadableStream<Uint8Array>, output: WritableStream<Uint8Array>, password: string): Promise<void>;
session.encryptStream(input, output): Promise<void>;   // 复用 session 已派生的密钥
session.decryptStream(input, output): Promise<void>;
```

## 流的所有权

- 调用即对 `input` 取 reader、对 `output` 取 writer（两端被锁定），返回后都已释放锁，但流本身已经用完，不要再读写。
- 成功：`input` 读到 EOF，再 `close()` `output`。`close()` 失败报 `刷新解密输出失败: <原因>`（加密为
  `刷新加密输出失败`），对应 Rust 的 `flush` 失败。
- 失败（密码错、数据损坏、读写出错）：先 `cancel(error)` `input`，再 `abort(error)` `output`，然后抛出。
  **已写出的部分由 output 负责丢弃**，所以目标文件要用 `ctx.files.openWrite(path, { mode: 'atomic' })`：
  写同目录临时文件，`close()` 时 fsync + rename，`abort()` 时删除临时文件，失败不会留下半个明文。
- DSBK v2：逐块认证、逐块写出。第 N 块被篡改时，前 N-1 块的明文已经交给 output，上一条决定它们会不会落盘。
- DSBK v1（旧备份）：整段读入内存、认证通过后一次写出，与 Rust 一样，内存占用等于备份大小。
- 写给 output 的分块归 output 所有（实现不会回收或清零）。
- `ctx.files.openRead` 的流在读到 EOF 时先关闭文件句柄，再结束流；解密在 `close()` output 前已读完 input，
  所以目标路径与源路径相同时，atomic 的 rename 也不会撞上仍打开的源文件（Windows 同样成立）。

## 错误

抛 `BackupCryptoError`，`message` 与路径版相同，例如：

- `非加密备份文件（无 DSBK 标头）`、`不支持的加密版本: <n>`、`加密分块大小非法: <n>`、`加密备份缺少数据块`
- `备份解密失败（密码错误或数据损坏）: aead::Error`（密码错和密文损坏不区分，同 Rust）
- `读取加密头失败: <原因>`、`写入解密输出失败: <原因>`、`刷新解密输出失败: <原因>`

调用方现有的错误包装（`proveTrialFailedError`、`SYNC_E2EE_WRONG_PASSWORD_CODE` 等）可以原样保留。

## 用法：password_proof 整文件试解（`sync-providers/src/password_proof.ts` `provePasswordWithWholeFile`）

只在首块试解返回 `LegacyV1WholeFile` 时才走整文件路径。现在的做法是下载到 `os.tmpdir()` 下的临时目录，
解密到 `.trial-decrypt.tmp` 再删掉；明文其实不需要落盘，解到一个丢弃型 sink 就够了：

```ts
const discard = new WritableStream<Uint8Array>({ write() {} });
try {
  await ports.backup.decryptBackupStream(await files.openRead(downloaded.localPath), discard, password);
} catch (error) {
  throw proveTrialFailedError(allowPlaintextZip, version.id, error);
}
```

能解开就证明密码正确（v1 整段认证；v2 每一块都认证）。下载目录仍由调用方清理。

## 用法：cloud_transfer 下载后解密（`sync-providers/src/cloud_transfer.ts` `finishDownloadedObject`）

现在是 `createTempFile(parent, '.cloud-decrypt-', '.tmp')` → `decryptBackupFile` → `rename` 回原路径。
换成流以后，atomic 写端代替自建临时文件与 rename：

```ts
try {
  await policy.backup.decryptBackupStream(
    await files.openRead(downloadedPath),
    await files.openWrite(downloadedPath, { mode: 'atomic' }),
    password,
  );
} catch (error) {
  throw new CloudStorageError('Validation', syncE2eeError(SYNC_E2EE_WRONG_PASSWORD_CODE,
    `解密备份失败（密码错或数据损坏）: ${errorMessage(error)}`));
}
```

注意两点差异，迁移时自行决定是否保留原来的文案拆分：

- 原代码把「创建临时文件失败」「保存解密后 ZIP 失败」分别报 `FileSystem`；流式版本里打开写端失败发生在
  `openWrite` 调用处（`FileError`，可以单独 try 保留原文案），rename 失败表现为 `刷新解密输出失败: …`。
- 写到与源相同的路径是安全的（见上文 EOF 关闭），也可以写到别的目标路径再交给后续流程。

上传方向（`prepareEncryptedUpload`）同理：`encryptBackupStream(await files.openRead(zip),
await files.openWrite(tempDsbk, { mode: 'exclusive' }), password)`；失败时 `exclusive` 写端不会自动删除，
需要调用方在 catch 里删除，或改用 `atomic` 并在成功后再使用该路径。
