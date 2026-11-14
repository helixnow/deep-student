/**
 * `crates/dstu-anki/src/anki/repository.rs::tests::repository_is_stateless_entry_point`
 * 的移植。
 *
 * Rust 的 `AnkiCardRepository` 是无字段的命名空间类型（`size_of == 0`）；
 * TS 侧对应 `repository/anki-cards.ts` 的纯函数集合。这里用运行时导出面
 * 断言同一语义：模块不持有连接/状态对象，每个入口都显式接收 db 句柄。
 */
import { describe, expect, it } from 'vitest';
import * as repository from '../repository/anki-cards.ts';

describe('crates/dstu-anki/src/anki/repository.rs::tests', () => {
  it('repository_is_stateless_entry_point', () => {
    const entries = Object.entries(repository);
    expect(entries.length).toBeGreaterThan(0);

    // 无状态：导出面只有函数，不存在模块级连接/缓存/可变状态对象。
    for (const [name, value] of entries) {
      expect(typeof value, `${name} 不得是状态对象`).toBe('function');
    }

    // 显式句柄：读写入口的第一个参数是 db（不捕获模块级连接）。
    expect(repository.listCardsForDocument.length).toBe(2);
    expect(repository.listCardsForTask.length).toBe(2);
    expect(repository.listRecentCards.length).toBe(2);
    // 删除入口额外显式接收 L15 FSRS 事务所有者（D1/D4），句柄仍为第一参数。
    expect(repository.deleteCard.length).toBe(3);
  });
});
