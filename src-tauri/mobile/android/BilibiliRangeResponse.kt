package com.deepstudent.app

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import java.io.FilterInputStream
import java.io.InputStream

/** Android seeks the request Range again, even when Rust has already returned HTTP 206. */
internal object BilibiliRangeResponse {
  private val contentRange = Regex("bytes (\\d+)-(\\d+)/(\\d+)")

  fun adapt(request: WebResourceRequest, response: WebResourceResponse?): WebResourceResponse? {
    if (request.url.host != "bilistream.localhost" || request.method != "GET" ||
      response == null || response.statusCode != 206 || response.data is BilibiliRangeInputStream) return response
    val value = response.responseHeaders?.entries
      ?.firstOrNull { it.key.equals("content-range", ignoreCase = true) }?.value ?: return response
    val match = contentRange.matchEntire(value) ?: return response
    val start = match.groupValues[1].toLongOrNull() ?: return response
    val end = match.groupValues[2].toLongOrNull() ?: return response
    val total = match.groupValues[3].toLongOrNull() ?: return response
    if (start > end || end >= total || end - start >= 512 * 1024) return response
    response.data = BilibiliRangeInputStream(response.data, start, end - start + 1)
    return response
  }
}

internal class BilibiliRangeInputStream(
  source: InputStream,
  offset: Long,
  private val length: Long,
) : FilterInputStream(source) {
  private var initial = true
  private var prefix = offset

  override fun available(): Int {
    if (initial) {
      initial = false
      // Chromium validates Range against available() before it calls skip().
      // Expose a virtual prefix without allocating or downloading those bytes.
      val virtualLength = prefix + length
      return if (virtualLength <= Int.MAX_VALUE) virtualLength.toInt() else 0
    }
    return super.available()
  }

  override fun skip(count: Long): Long {
    if (count <= 0) return 0
    if (prefix > 0) {
      // WebView narrows skip()'s result to an int and repeats until satisfied.
      val skipped = minOf(count, prefix, Int.MAX_VALUE.toLong())
      prefix -= skipped
      return skipped
    }
    return super.skip(count)
  }
}
