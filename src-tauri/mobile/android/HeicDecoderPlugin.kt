package com.deepstudent.app

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.sqrt

// NOTE: 此文件有受控副本 src-tauri/mobile/android/HeicDecoderPlugin.kt。
// 由 scripts/build_android.sh / reusable-build-android.yml 同步进生成工程；
// 重新执行 `tauri android init` 后同步逻辑会自动恢复本文件。

@InvokeArg
class ConvertHeicArgs {
  lateinit var inputPath: String
  lateinit var outputPath: String
  var quality: Int = 90
  var maxPixels: Long = 16_000_000L
}

/**
 * HEIC/HEIF → JPEG 原生转码。
 *
 * 背景：Android System WebView（Chromium）不能解码 HEIC，而 JS/WASM 解码器
 * （heic2any 的 Emscripten 胶水依赖 `new Function`）被 release CSP
 * `script-src 'self'` 拦截。Android 9（API 28）起平台 ImageDecoder 原生支持
 * HEIF（含 irot/imir 方向变换），这里直接调用系统解码器。
 *
 * 输入/输出均走应用私有缓存目录中的临时文件（由 Rust 命令 `convert_heic_to_jpeg`
 * 创建和清理），避免把数 MB 的 base64 塞进 JNI JSON 通道。
 */
@TauriPlugin
class HeicDecoderPlugin(private val activity: Activity) : Plugin(activity) {
  private val executor = Executors.newSingleThreadExecutor { task ->
    Thread(task, "heic-decoder")
  }

  @Command
  fun convertToJpeg(invoke: Invoke) {
    val args = try {
      invoke.parseArgs(ConvertHeicArgs::class.java)
    } catch (error: Exception) {
      invoke.reject("Invalid HEIC conversion arguments: ${error.message}")
      return
    }
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
      invoke.reject(
        "HEIC_UNSUPPORTED_OS: HEIC decoding requires Android 9 (API 28) or later; this device runs API ${Build.VERSION.SDK_INT}"
      )
      return
    }
    // 解码大图耗时数百毫秒，放到后台线程，不占插件调用线程。
    executor.execute {
      try {
        val (width, height) = decodeToJpeg(args)
        val result = JSObject()
        result.put("width", width)
        result.put("height", height)
        invoke.resolve(result)
      } catch (error: OutOfMemoryError) {
        invoke.reject("HEIC_DECODE_FAILED: out of memory while decoding image")
      } catch (error: Exception) {
        invoke.reject("HEIC_DECODE_FAILED: ${error.message ?: error.javaClass.simpleName}")
      }
    }
  }

  @androidx.annotation.RequiresApi(Build.VERSION_CODES.P)
  private fun decodeToJpeg(args: ConvertHeicArgs): Pair<Int, Int> {
    val input = File(args.inputPath)
    if (!input.isFile) {
      throw IllegalArgumentException("input file not found")
    }
    val maxPixels = max(1L, args.maxPixels)
    val quality = args.quality.coerceIn(1, 100)
    val source = ImageDecoder.createSource(input)
    val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
      // 软件分配：HARDWARE 位图不能 compress。
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      val w = info.size.width.toLong()
      val h = info.size.height.toLong()
      val pixels = w * h
      if (pixels > maxPixels) {
        val scale = sqrt(maxPixels.toDouble() / pixels.toDouble())
        decoder.setTargetSize(
          max(1, (w * scale).toInt()),
          max(1, (h * scale).toInt())
        )
      }
    }
    // JPEG 无 alpha：带透明通道的 HEIF 先铺白底，避免透明区域被编码成黑色。
    val opaque = if (bitmap.hasAlpha()) {
      val flattened = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
      Canvas(flattened).apply {
        drawColor(Color.WHITE)
        drawBitmap(bitmap, 0f, 0f, null)
      }
      bitmap.recycle()
      flattened
    } else {
      bitmap
    }
    try {
      val output = File(args.outputPath)
      FileOutputStream(output).use { stream ->
        if (!opaque.compress(Bitmap.CompressFormat.JPEG, quality, stream)) {
          throw IllegalStateException("JPEG encoder rejected bitmap")
        }
      }
      return Pair(opaque.width, opaque.height)
    } finally {
      opaque.recycle()
    }
  }
}
