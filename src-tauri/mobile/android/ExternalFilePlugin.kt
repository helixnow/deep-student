package com.deepstudent.app

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.util.Locale

// NOTE: 此文件有受控副本 src-tauri/mobile/android/ExternalFilePlugin.kt。
// 由 scripts/build_android.sh / reusable-build-android.yml 同步进生成工程；
// 重新执行 `tauri android init` 后同步逻辑会自动恢复本文件。

@InvokeArg
class OpenExternalFileArgs {
  lateinit var path: String
  var mode: String? = null
}

/**
 * 用其他应用打开 / 分享文件（移动端"打开""在文件夹中显示"的统一落地）。
 *
 * 背景：opener 插件的 Android `open_path` 参数格式与 Kotlin 侧不匹配且只会
 * `Uri.parse`（file:// 在 Android 7+ 触发 FileUriExposedException），
 * `reveal_item_in_dir` 在移动端直接不支持。
 *
 * Rust（external_file_opener.rs）已把本地文件复制到 cache/shared/<uuid>/，
 * 这里只通过 FileProvider（仅暴露 cache/shared/ 与 cache/updates/）授权：
 * - mode=view：ACTION_VIEW + 推断 MIME；没有应用能打开该类型时回退分享面板；
 * - mode=share：ACTION_SEND 分享面板。
 * `content://`（SAF 保存结果）直接透传，由系统按我们已持有的授权转授。
 * resolve 返回 { action: "view" | "share" } 告知前端实际动作。
 */
@TauriPlugin
class ExternalFilePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun open(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(OpenExternalFileArgs::class.java)
      val uri: Uri
      val displayName: String
      if (args.path.trim().startsWith("content://", ignoreCase = true)) {
        uri = Uri.parse(args.path.trim())
        displayName = uri.lastPathSegment ?: ""
      } else {
        val file = File(args.path)
        if (!file.isFile) {
          invoke.reject("File not found: ${args.path}")
          return
        }
        uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
        displayName = file.name
      }
      val mime = resolveMimeType(uri, displayName)

      if (args.mode == "share") {
        startShare(uri, mime)
        invoke.resolve(JSObject().put("action", "share"))
        return
      }

      // 文本类按具体子类型找不到应用时再试 text/plain（多数阅读器只注册了它）
      val candidates = if (mime.startsWith("text/") && mime != "text/plain") {
        listOf(mime, "text/plain")
      } else {
        listOf(mime)
      }
      for (candidate in candidates) {
        try {
          startView(uri, candidate)
          invoke.resolve(JSObject().put("action", "view"))
          return
        } catch (ignored: ActivityNotFoundException) {
          // 继续下一个候选 / 回退分享
        }
      }
      // 没有应用能直接打开该类型：退到分享面板，用户仍可发给网盘/聊天/其他应用
      startShare(uri, mime)
      invoke.resolve(JSObject().put("action", "share"))
    } catch (ex: Exception) {
      invoke.reject(ex.message ?: "Failed to open file")
    }
  }

  private fun startView(uri: Uri, mime: String) {
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, mime)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(intent)
  }

  private fun startShare(uri: Uri, mime: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
      type = mime
      putExtra(Intent.EXTRA_STREAM, uri)
      clipData = ClipData.newRawUri("", uri)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(send, null).apply {
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    activity.startActivity(chooser)
  }

  private fun resolveMimeType(uri: Uri, displayName: String): String {
    // 外部 provider（SAF 保存结果）自己最清楚类型；document ID 往往不含扩展名
    if (uri.authority != "${activity.packageName}.fileprovider") {
      queryProviderType(uri)?.let { return it }
    }
    val ext = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT)
    EXTENSION_OVERRIDES[ext]?.let { return it }
    MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext)?.let { return it }
    return queryProviderType(uri) ?: "application/octet-stream"
  }

  private fun queryProviderType(uri: Uri): String? {
    return try {
      activity.contentResolver.getType(uri)?.takeIf { it.isNotBlank() && it != "application/octet-stream" }
    } catch (ignored: Exception) {
      // 部分 provider 查询类型会抛 SecurityException，按未知类型处理
      null
    }
  }

  private companion object {
    /** 系统 MimeTypeMap 缺失或不准的常见类型 */
    val EXTENSION_OVERRIDES = mapOf(
      "md" to "text/markdown",
      "markdown" to "text/markdown",
      "log" to "text/plain",
      "jsonl" to "text/plain",
      "apkg" to "application/apkg",
      "colpkg" to "application/apkg",
    )
  }
}
