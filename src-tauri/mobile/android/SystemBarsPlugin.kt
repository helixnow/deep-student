package com.deepstudent.app

import android.app.Activity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

// NOTE: 此文件有受控副本 src-tauri/mobile/android/SystemBarsPlugin.kt。
// 由 scripts/build_android.sh / reusable-build-android.yml 同步进生成工程。

@InvokeArg
class SetImmersiveArgs {
  var enabled: Boolean = false
}

/**
 * #472: 沉浸式全屏开关（隐藏状态栏 + 导航栏，从屏幕边缘滑动临时呼出）。
 *
 * 插件只做转发：显隐逻辑与持久化（冷启动时在前端加载前即生效）都在
 * [MainActivity.setImmersiveMode]，系统栏显隐后 inset 监听会把新的安全区
 * 重新注入前端，顶栏留白随之收起 / 恢复。
 */
@TauriPlugin
class SystemBarsPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setImmersive(invoke: Invoke) {
    val mainActivity = activity as? MainActivity
    if (mainActivity == null) {
      invoke.reject("immersive mode requires MainActivity")
      return
    }
    try {
      val args = invoke.parseArgs(SetImmersiveArgs::class.java)
      mainActivity.setImmersiveMode(args.enabled)
      invoke.resolve()
    } catch (error: Exception) {
      invoke.reject(error.message ?: "set immersive mode failed")
    }
  }
}
