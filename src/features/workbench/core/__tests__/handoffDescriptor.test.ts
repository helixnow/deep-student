/**
 * Wave2-B r7 — handoffDescriptor（双壳焦点上下文交接）单测
 *
 * 覆盖任务卡四条主线：
 * 1. parse / serialize 纯函数往返与逐字段 sanitize；
 * 2. consume 一次即清（无论有效 / 陈旧 / 损坏，先删存储条目再判返回值）；
 * 3. 陈旧超时作废（DEFAULT_HANDOFF_MAX_AGE_MS 新鲜度窗口，边界含等号语义）；
 * 4. 坏 payload 整体作废返回 null，绝不抛错。
 *
 * storage 全程注入内存 mock，不碰 jsdom localStorage，不触碰产品代码。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HANDOFF_MAX_AGE_MS,
  HANDOFF_DESCRIPTOR_VERSION,
  WORKBENCH_HANDOFF_STORAGE_KEY,
  buildHandoffDescriptor,
  consumeHandoffDescriptor,
  parseHandoffDescriptor,
  saveHandoffDescriptor,
  serializeHandoffDescriptor,
} from '../handoffDescriptor';

/** 内存版 Storage（只实现 handoffDescriptor 用到的三个方法） */
function createMemoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

const NOW = 1_756_000_000_000;

describe('serializeHandoffDescriptor / buildHandoffDescriptor', () => {
  it('合法三元组 → 完整信封（version=1、savedAt=now、字段原样）', () => {
    const raw = serializeHandoffDescriptor(
      { appType: 'note', resourceId: 'note-42', innerRoute: 'page:12' },
      NOW,
    );
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({
      version: HANDOFF_DESCRIPTOR_VERSION,
      appType: 'note',
      resourceId: 'note-42',
      innerRoute: 'page:12',
      savedAt: NOW,
    });
  });

  it('appType 非法（空 / 非字符串 / 非法字符）→ 整体 null', () => {
    expect(serializeHandoffDescriptor({ appType: '', resourceId: null }, NOW)).toBeNull();
    expect(
      serializeHandoffDescriptor({ appType: '   ', resourceId: null }, NOW),
    ).toBeNull();
    expect(
      serializeHandoffDescriptor(
        { appType: 'has space', resourceId: null },
        NOW,
      ),
    ).toBeNull();
    expect(
      serializeHandoffDescriptor(
        // 故意传坏类型验证运行时 sanitize（绕过编译期检查）
        { appType: 42 as unknown as string, resourceId: null },
        NOW,
      ),
    ).toBeNull();
  });

  it('resourceId / innerRoute 坏则逐字段收敛，不作废整体', () => {
    const descriptor = buildHandoffDescriptor(
      {
        appType: 'textbook',
        // 超长 resourceId → null（字段级收敛）
        resourceId: 'x'.repeat(257),
        // 纯控制字符 innerRoute → 剥离后为空 → 省略
        innerRoute: '\u0000\u001f\u007f',
      },
      NOW,
    );
    expect(descriptor).not.toBeNull();
    expect(descriptor?.resourceId).toBeNull();
    expect(descriptor).not.toHaveProperty('innerRoute');
  });

  it('innerRoute 剥控制字符、两端去空后保留', () => {
    const descriptor = buildHandoffDescriptor(
      { appType: 'chat', resourceId: 'sess-1', innerRoute: ' tab:a\u0000bc \n' },
      NOW,
    );
    expect(descriptor?.innerRoute).toBe('tab:abc');
  });

  it('now 非法（NaN / 负数）回落 Date.now()，savedAt 恒为正', () => {
    const descriptor = buildHandoffDescriptor(
      { appType: 'note', resourceId: null },
      Number.NaN,
    );
    expect(descriptor?.savedAt).toBeGreaterThan(0);
  });
});

describe('parseHandoffDescriptor', () => {
  it('serialize → parse 往返一致（字符串与对象两种入参）', () => {
    const raw = serializeHandoffDescriptor(
      { appType: 'exam', resourceId: 'ex-7', innerRoute: 'tab:analysis' },
      NOW,
    ) as string;
    const fromString = parseHandoffDescriptor(raw);
    const fromObject = parseHandoffDescriptor(JSON.parse(raw));
    expect(fromString).toEqual({
      version: HANDOFF_DESCRIPTOR_VERSION,
      appType: 'exam',
      resourceId: 'ex-7',
      innerRoute: 'tab:analysis',
      savedAt: NOW,
    });
    expect(fromObject).toEqual(fromString);
  });

  it('坏 payload 一律 null 且不抛错', () => {
    const badPayloads: unknown[] = [
      null,
      undefined,
      '',
      '   ',
      'not-json{',
      '[]',
      '42',
      '"note"',
      JSON.stringify({ appType: 'note', resourceId: null, savedAt: NOW }), // 缺 version
      JSON.stringify({ version: 2, appType: 'note', resourceId: null, savedAt: NOW }), // 版本不符
      JSON.stringify({ version: 1, resourceId: null, savedAt: NOW }), // 缺 appType
      JSON.stringify({ version: 1, appType: 'bad app!', resourceId: null, savedAt: NOW }),
      JSON.stringify({ version: 1, appType: 'note', resourceId: null }), // 缺 savedAt
      JSON.stringify({ version: 1, appType: 'note', resourceId: null, savedAt: 0 }),
      JSON.stringify({ version: 1, appType: 'note', resourceId: null, savedAt: -5 }),
      JSON.stringify({ version: 1, appType: 'note', resourceId: null, savedAt: 'soon' }),
    ];
    for (const payload of badPayloads) {
      expect(parseHandoffDescriptor(payload), `payload=${String(payload)}`).toBeNull();
    }
  });

  it('innerRoute 坏只省略该字段，descriptor 仍有效', () => {
    const parsed = parseHandoffDescriptor(
      JSON.stringify({
        version: 1,
        appType: 'note',
        resourceId: 'n-1',
        innerRoute: 12345,
        savedAt: NOW,
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty('innerRoute');
    expect(parsed?.resourceId).toBe('n-1');
  });

  it('多余字段被丢弃，产出只含信封既定形状', () => {
    const parsed = parseHandoffDescriptor(
      // 手写 JSON：确保 __proto__ 作为普通键出现在载荷里（对象字面量写法会被引擎吃掉）
      `{"version":1,"appType":"note","resourceId":"n-1","savedAt":${NOW},` +
        '"extra":"should-drop","__proto__":{"evil":true}}',
    );
    expect(parsed).toEqual({
      version: HANDOFF_DESCRIPTOR_VERSION,
      appType: 'note',
      resourceId: 'n-1',
      savedAt: NOW,
    });
  });
});

describe('consumeHandoffDescriptor — 一次即清', () => {
  it('有效且新鲜：首次返回 descriptor 并清除存储，二次消费 null', () => {
    const storage = createMemoryStorage();
    const saved = saveHandoffDescriptor(
      { appType: 'note', resourceId: 'n-9', innerRoute: 'page:3' },
      storage,
      NOW,
    );
    expect(saved).not.toBeNull();
    expect(storage.map.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(true);

    const first = consumeHandoffDescriptor({ storage, now: NOW + 1_000 });
    expect(first).toEqual(saved);
    // 消费即清：条目已删
    expect(storage.map.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(false);
    // 同一份交接绝不被第二个消费方再应用一次
    expect(consumeHandoffDescriptor({ storage, now: NOW + 2_000 })).toBeNull();
  });

  it('坏 payload：返回 null 但同样先清存储（不永久滞留）', () => {
    const storage = createMemoryStorage();
    storage.setItem(WORKBENCH_HANDOFF_STORAGE_KEY, 'corrupted{{{');
    expect(consumeHandoffDescriptor({ storage, now: NOW })).toBeNull();
    expect(storage.map.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(false);
  });

  it('storage 读取抛错：静默返回 null，不抛出', () => {
    const throwing = {
      getItem: () => {
        throw new Error('quota');
      },
      setItem: () => {},
      removeItem: () => {},
    };
    expect(() => consumeHandoffDescriptor({ storage: throwing })).not.toThrow();
    expect(consumeHandoffDescriptor({ storage: throwing })).toBeNull();
  });
});

describe('consumeHandoffDescriptor — 陈旧超时作废', () => {
  function seed(storage: ReturnType<typeof createMemoryStorage>, savedAt: number) {
    saveHandoffDescriptor({ appType: 'note', resourceId: 'n-1' }, storage, savedAt);
  }

  it('超过 DEFAULT_HANDOFF_MAX_AGE_MS → null，且存储同样被清', () => {
    const storage = createMemoryStorage();
    seed(storage, NOW);
    const result = consumeHandoffDescriptor({
      storage,
      now: NOW + DEFAULT_HANDOFF_MAX_AGE_MS + 1,
    });
    expect(result).toBeNull();
    expect(storage.map.has(WORKBENCH_HANDOFF_STORAGE_KEY)).toBe(false);
  });

  it('恰好等于窗口上限不算陈旧（判定用严格大于）', () => {
    const storage = createMemoryStorage();
    seed(storage, NOW);
    const result = consumeHandoffDescriptor({
      storage,
      now: NOW + DEFAULT_HANDOFF_MAX_AGE_MS,
    });
    expect(result?.appType).toBe('note');
  });

  it('自定义 maxAgeMs 生效；Infinity 关闭陈旧判定', () => {
    const stale = createMemoryStorage();
    seed(stale, NOW);
    expect(
      consumeHandoffDescriptor({ storage: stale, now: NOW + 5_001, maxAgeMs: 5_000 }),
    ).toBeNull();

    const forever = createMemoryStorage();
    seed(forever, NOW);
    expect(
      consumeHandoffDescriptor({
        storage: forever,
        now: NOW + DEFAULT_HANDOFF_MAX_AGE_MS * 100,
        maxAgeMs: Number.POSITIVE_INFINITY,
      }),
    ).not.toBeNull();
  });
});
