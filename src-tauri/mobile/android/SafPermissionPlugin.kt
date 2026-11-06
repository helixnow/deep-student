package com.deepstudent.app

import android.app.Activity
import android.net.Uri
import android.provider.OpenableColumns
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

// 受控副本由本地 Android 构建脚本和 CI 同步进生成工程。
// URI 仍只从 Rust 原子写入的私有队列读取，插件只负责唤醒后台扫描。
@InvokeArg
class ResolveFileInfoArgs {
  lateinit var path: String
}

@TauriPlugin
class SafPermissionPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun persistPending(invoke: Invoke) {
    val mainActivity = activity as? MainActivity
    if (mainActivity == null) {
      invoke.reject("SAF permission queue requires MainActivity")
      return
    }
    try {
      mainActivity.requestSafPermissionPersist()
      invoke.resolve()
    } catch (error: Exception) {
      // Activity 已销毁时不能接收新任务；保留磁盘队列，由下一次恢复补扫。
      invoke.reject(error.message ?: "SAF permission queue wake failed")
    }
  }

  /**
   * 查询 content:// 的 DISPLAY_NAME / MIME，供 Rust 导入分流使用。
   * 只返回 provider 元数据，不读取正文、不复制 URI grant；字段缺失时留空，
   * 由 Rust 有界内容检测继续兜底。
   */
  @Command
  fun resolveFileInfo(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(ResolveFileInfoArgs::class.java)
    } catch (error: Exception) {
      invoke.reject(error.message ?: "Invalid resolveFileInfo arguments")
      return
    }
    val rawPath = args.path.trim()
    if (!rawPath.startsWith("content://", ignoreCase = true)) {
      invoke.reject("resolveFileInfo requires a content:// URI")
      return
    }
    val uri = Uri.parse(rawPath)
    val payload = JSObject()
    try {
      activity.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
          val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
          if (nameIndex >= 0 && !cursor.isNull(nameIndex)) {
            cursor.getString(nameIndex)?.takeIf { it.isNotBlank() }?.let {
              payload.put("displayName", it)
            }
          }
        }
      }
    } catch (ignored: Exception) {
      // 部分 provider 会因权限/游标异常拒绝元数据查询；保留空字段走内容检测。
    }
    try {
      activity.contentResolver.getType(uri)?.takeIf { it.isNotBlank() }?.let {
        payload.put("mimeType", it)
      }
    } catch (ignored: Exception) {
      // 元数据是可选项，读取正文仍由 Rust 的受控流完成。
    }
    invoke.resolve(payload)
  }
}
