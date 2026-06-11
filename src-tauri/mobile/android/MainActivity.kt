package com.deepstudent.app

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge

// NOTE: 此文件有受控副本 src-tauri/mobile/android/MainActivity.kt。
// 重新执行 `tauri android init` 后请从受控副本同步本文件。
class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // A-5: 系统返回键接管。TauriActivity 关闭了默认返回处理（handleBackNavigation=false），
    // 若不注册回调，返回键会直接 finish Activity 导致应用退出。
    // 这里把返回事件转发给前端协调器（关闭浮层/导航后退），未消费时退到后台而非杀进程。
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = appWebView
        if (webView == null) {
          moveTaskToBack(true)
          return
        }
        webView.evaluateJavascript(
          "(function(){try{return window.__DEEP_STUDENT_HANDLE_BACK__?window.__DEEP_STUDENT_HANDLE_BACK__():false}catch(e){return false}})()"
        ) { result ->
          if (result != "true") {
            moveTaskToBack(true)
          }
        }
      }
    })
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    super.onWebViewCreate(webView)
  }
}
