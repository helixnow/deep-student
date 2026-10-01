package com.deepstudent.app

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

// 受控副本由本地 Android 构建脚本和 CI 同步进生成工程。
// URI 仍只从 Rust 原子写入的私有队列读取，插件只负责唤醒后台扫描。
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
}
