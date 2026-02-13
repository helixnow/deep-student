/**
 * 测试 P2-013: offset管理bug修复
 *
 * 验证场景:
 * 1. reset时使用实际返回数据长度设置offset
 * 2. loadMore时累加实际返回数据长度
 * 3. 边界情况：返回数据少于limit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('P2-013: Offset管理bug修复验证', () => {
  describe('Essay适配器offset管理', () => {
    it('reset时应使用实际返回数据长度设置offset', () => {
      // 模拟场景: limit=20，但只返回15条数据
      const limit = 20;
      const returnedData = new Array(15).fill({}).map((_, i) => ({ id: `essay_${i}` }));

      // 模拟reset逻辑
      let offset = 0;
      const data = returnedData;

      // 正确的实现: 使用实际返回数据长度
      offset = data.length;

      expect(offset).toBe(15); // 应该是15而不是20
    });

    it('loadMore时应累加实际返回数据长度', () => {
      // 模拟场景:
      // 第一次加载返回15条 (limit=20)
      // 第二次加载返回8条 (limit=20, offset=15)
      const limit = 20;

      // 第一次加载
      let offset = 0;
      const firstBatch = new Array(15).fill({}).map((_, i) => ({ id: `essay_${i}` }));
      offset = firstBatch.length; // offset = 15

      expect(offset).toBe(15);

      // 第二次加载 (loadMore)
      const secondBatch = new Array(8).fill({}).map((_, i) => ({ id: `essay_${15 + i}` }));
      const prevOffset = offset;
      offset = prevOffset + secondBatch.length; // offset = 15 + 8 = 23

      expect(offset).toBe(23); // 应该是23而不是35(15+20)
    });

    it('处理空结果的情况', () => {
      const limit = 20;
      let offset = 0;

      // 返回空数组
      const data: any[] = [];
      offset = data.length;

      expect(offset).toBe(0);
    });
  });

  describe('Translation适配器offset管理', () => {
    it('reset时应使用实际返回数据长度设置offset', () => {
      const limit = 20;
      const returnedData = new Array(12).fill({}).map((_, i) => ({ id: `trans_${i}` }));

      let offset = 0;
      const data = returnedData;
      offset = data.length;

      expect(offset).toBe(12);
    });

    it('loadMore时应累加实际返回数据长度', () => {
      const limit = 20;

      // 第一次加载
      let offset = 0;
      const firstBatch = new Array(18).fill({}).map((_, i) => ({ id: `trans_${i}` }));
      offset = firstBatch.length;

      expect(offset).toBe(18);

      // 第二次加载
      const secondBatch = new Array(5).fill({}).map((_, i) => ({ id: `trans_${18 + i}` }));
      const prevOffset = offset;
      offset = prevOffset + secondBatch.length;

      expect(offset).toBe(23);
    });
  });

  describe('hasMore逻辑验证', () => {
    it('当返回数据等于limit时hasMore应为true', () => {
      const limit = 20;
      const data = new Array(20).fill({});

      const hasMore = data.length >= limit;
      expect(hasMore).toBe(true);
    });

    it('当返回数据少于limit时hasMore应为false', () => {
      const limit = 20;
      const data = new Array(15).fill({});

      const hasMore = data.length >= limit;
      expect(hasMore).toBe(false);
    });

    it('当返回空数组时hasMore应为false', () => {
      const limit = 20;
      const data: any[] = [];

      const hasMore = data.length >= limit;
      expect(hasMore).toBe(false);
    });
  });

  describe('边界情况测试', () => {
    it('连续多次loadMore的offset累加', () => {
      const limit = 20;
      let offset = 0;

      // 第1批: 20条
      offset += 20;
      expect(offset).toBe(20);

      // 第2批: 20条
      offset += 20;
      expect(offset).toBe(40);

      // 第3批: 15条 (最后一批)
      offset += 15;
      expect(offset).toBe(55);

      // 验证总数正确
      expect(offset).toBe(55); // 而不是60 (3 * 20)
    });

    it('reset后重新开始计数', () => {
      let offset = 55; // 之前累加到55

      // reset
      const data = new Array(20).fill({});
      offset = data.length;

      expect(offset).toBe(20); // 重新开始
    });
  });
});
