package com.deepstudent.app

import java.io.ByteArrayInputStream
import org.junit.Assert.*
import org.junit.Test

class BilibiliRangeInputStreamTest {
  private val bytes = ByteArray(65536) { (it % 251).toByte() }

  @Test fun skipsVirtualPrefixWithoutDiscardingTheActualRangeBytes() {
    val input = BilibiliRangeInputStream(ByteArrayInputStream(bytes), 3_000_000, bytes.size.toLong())
    assertEquals(3_000_000 + bytes.size, input.available())
    assertEquals(3_000_000L, input.skip(3_000_000))
    assertEquals(bytes.size, input.available())
    assertArrayEquals(bytes, input.readBytes())
  }

  @Test fun largeOffsetsUseBoundedSkipsForTheWebViewIntResult() {
    val input = BilibiliRangeInputStream(ByteArrayInputStream(bytes), 3_000_000_000, bytes.size.toLong())
    assertEquals(0, input.available())
    val first = input.skip(3_000_000_000)
    assertEquals(Int.MAX_VALUE.toLong(), first)
    assertEquals(3_000_000_000 - first, input.skip(3_000_000_000 - first))
    assertArrayEquals(bytes, input.readBytes())
  }

  @Test fun ordinaryReadsSkipsAndCloseRemainDelegatedToTheBoundedBody() {
    val input = BilibiliRangeInputStream(ByteArrayInputStream(bytes), 0, bytes.size.toLong())
    assertEquals(bytes.size, input.available())
    assertEquals(0L, input.skip(-1))
    assertEquals(4L, input.skip(4))
    assertArrayEquals(bytes.copyOfRange(4, bytes.size), input.readBytes())
    assertEquals(-1, input.read())
    input.close()
  }
}
