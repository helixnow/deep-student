package com.deepstudent.app

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

// NOTE: 此文件有受控副本 src-tauri/mobile/android/ApkInstallerPlugin.kt。
// 由 scripts/build_android.sh / reusable-build-android.yml 同步进生成工程；
// 重新执行 `tauri android init` 后同步逻辑会自动恢复本文件。

@InvokeArg
class InstallApkArgs {
  lateinit var path: String
}

/**
 * 应用内 APK 安装器。
 *
 * 背景：opener 插件的 Android 实现只能 ACTION_VIEW 打开 URL（Uri.parse），
 * 无法把本地文件转成 FileProvider 的 content:// URI（file:// 在 Android 7+
 * 会被 FileUriExposedException 拒绝），因此应用内更新的最后一步需要本插件。
 *
 * 前端负责把 APK 下载到应用私有目录（$APPCACHE/updates/），这里仅通过
 * FileProvider 授权后拉起系统安装器。覆盖安装要求签名一致且 versionCode
 * 递增（两者均由发布流水线保证）；用户会在系统安装器界面看到确认提示，
 * 首次安装需按系统引导授予"安装未知应用"权限。
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun install(invoke: Invoke) {
    try {
      val args = invoke.parseArgs(InstallApkArgs::class.java)
      val file = File(args.path)
      if (!file.exists()) {
        invoke.reject("APK not found: ${args.path}")
        return
      }
      val uri = FileProvider.getUriForFile(
        activity,
        "${activity.packageName}.fileprovider",
        file
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      activity.startActivity(intent)
      invoke.resolve()
    } catch (ex: Exception) {
      invoke.reject(ex.message)
    }
  }
}
