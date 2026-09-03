package com.deepstudent.app

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.File

// NOTE: 此文件有受控副本 src-tauri/mobile/android/MainActivity.kt。
// 重新执行 `tauri android init` 后请从受控副本同步本文件。
class MainActivity : TauriActivity() {
  private var appWebView: WebView? = null

  /** 最近一次系统栏 + 刘海 inset（CSS px：物理 px / density），等 WebView 就绪后注入 */
  private var lastSafeAreaCssPx: IntArray? = null

  /**
   * Tauri dialog 走 Activity Result API，[onActivityResult] 拦截不到授权回调。
   * Rust 把待 persist 的 `content://` 原子写入 [filesDir]/pending_saf_persist/ 下的 *.uri 文件，
   * 并双读旧单文件 pending_saf_persist.uri。前台立刻尝试并每 400ms 轮询。
   * `ACTION_GET_CONTENT` 常常不可 persist：SecurityException 必须删队列并 warn，
   * 不得假装已授权。
   */
  private val persistHandler = Handler(Looper.getMainLooper())
  private val persistPoll = object : Runnable {
    override fun run() {
      persistPendingSafUri()
      persistHandler.postDelayed(this, PERSIST_POLL_MS)
    }
  }

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

    // SA-1: 真实安全区注入。Android WebView 的 env(safe-area-inset-*) 在 edge-to-edge
    // 下不可靠，前端 platform.ts 只能用固定猜测值兜底（top 24 / bottom 15）。
    // 这里监听真实 WindowInsets（含旋转、手势/三键导航切换、刘海/打孔屏），
    // 换算成 CSS px 后注入前端，由 platform.ts 的 __DEEP_STUDENT_SET_SAFE_AREA__ 应用。
    ViewCompat.setOnApplyWindowInsetsListener(window.decorView) { _, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = resources.displayMetrics.density
      if (density > 0f) {
        lastSafeAreaCssPx = intArrayOf(
          Math.round(bars.top / density),
          Math.round(bars.bottom / density),
          Math.round(bars.left / density),
          Math.round(bars.right / density),
        )
        applySafeAreaToWebView()
      }
      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    appWebView = webView
    super.onWebViewCreate(webView)
    // 首帧注入 + 延迟重试：evaluateJavascript 可能早于前端 bundle 执行，
    // 此时先落到 __DEEP_STUDENT_PENDING_SAFE_AREA__ 暂存；若页面上下文随后被
    // 导航替换（about:blank → 应用页），暂存会丢失，因此分多个时间点补发，
    // 覆盖冷启动页面加载窗口。
    applySafeAreaToWebView()
    for (delayMs in longArrayOf(500L, 1500L, 4000L)) {
      webView.postDelayed({ applySafeAreaToWebView() }, delayMs)
    }
  }

  override fun onResume() {
    super.onResume()
    // 页面若发生过重载，JS 端会退回 fallback 值；恢复前台时重新注入真实值。
    applySafeAreaToWebView()
    persistPendingSafUri()
    persistHandler.removeCallbacks(persistPoll)
    persistHandler.postDelayed(persistPoll, PERSIST_POLL_MS)
  }

  override fun onPause() {
    persistHandler.removeCallbacks(persistPoll)
    super.onPause()
  }

  private fun persistPendingSafUri() {
    val queued = mutableListOf<File>()
    val legacy = File(filesDir, PENDING_SAF_PERSIST_FILE)
    if (legacy.isFile) {
      queued.add(legacy)
    }
    val directory = File(filesDir, PENDING_SAF_PERSIST_DIR)
    if (directory.isDirectory) {
      directory.listFiles()
        ?.filter { it.isFile && it.name.endsWith(".uri") }
        ?.let { queued.addAll(it) }
    }
    for (pending in queued) {
      persistQueuedSafFile(pending)
    }
  }

  private fun persistQueuedSafFile(pending: File) {
    val raw = try {
      pending.readText().trim()
    } catch (error: Exception) {
      Log.w(TAG, "read pending SAF persist queue failed", error)
      return
    }
    if (raw.isEmpty() || !raw.startsWith("content://", ignoreCase = true)) {
      if (!pending.delete()) {
        Log.w(TAG, "invalid pending SAF persist queue could not be deleted")
      }
      return
    }
    val uri = Uri.parse(raw)
    if (!"content".equals(uri.scheme, ignoreCase = true)) {
      Log.w(TAG, "pending SAF persist queue is not a content URI")
      pending.delete()
      return
    }
    val readWrite = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
    try {
      contentResolver.takePersistableUriPermission(uri, readWrite)
      if (!pending.delete()) {
        Log.w(TAG, "SAF persist succeeded but queue file remains")
      }
      return
    } catch (writeDenied: SecurityException) {
      try {
        contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        Log.w(
          TAG,
          "SAF persist write refused; kept read-only. Async export after process death is not promised. uri=$uri",
        )
        pending.delete()
        return
      } catch (readDenied: SecurityException) {
        Log.w(
          TAG,
          "takePersistableUriPermission refused (likely ACTION_GET_CONTENT). Current-process grant only. uri=$uri",
          readDenied,
        )
        pending.delete()
      }
    }
  }

  private fun applySafeAreaToWebView() {
    val webView = appWebView ?: return
    val insets = lastSafeAreaCssPx ?: return
    val top = insets[0]
    val bottom = insets[1]
    val left = insets[2]
    val right = insets[3]
    val js =
      "(function(){try{" +
        "if(window.__DEEP_STUDENT_SET_SAFE_AREA__){window.__DEEP_STUDENT_SET_SAFE_AREA__($top,$bottom,$left,$right);}" +
        "else{window.__DEEP_STUDENT_PENDING_SAFE_AREA__=[$top,$bottom,$left,$right];}" +
        "}catch(e){}})()"
    webView.post { webView.evaluateJavascript(js, null) }
  }

  private companion object {
    private const val TAG = "DeepStudentSaf"
    private const val PENDING_SAF_PERSIST_FILE = "pending_saf_persist.uri"
    private const val PENDING_SAF_PERSIST_DIR = "pending_saf_persist"
    private const val PERSIST_POLL_MS = 400L
  }
}
