import { sanitizeEntities, sanitizeEvent, toList, toNumber, toText } from '@/data/utils/sanitize';
import { describe, expect, it } from 'vitest';

describe('脏数据净化层', () => {
    it('toText: 数字/布尔/数组/对象都能转成文本且不抛', () => {
        expect(toText('abc')).toBe('abc');
        expect(toText(1024)).toBe('1024');
        expect(toText(true)).toBe('true');
        expect(toText(['a', 1])).toBe('a 1');
        expect(toText(null)).toBe('');
        expect(toText(undefined)).toBe('');
        expect(() => toText({ a: 1 })).not.toThrow();
    });

    it('toList: 字符串按整体处理，不会逐字符拆开', () => {
        expect(toList('王城')).toEqual(['王城']);
        expect(toList(['a', 'b'])).toEqual(['a', 'b']);
        expect(toList(42)).toEqual(['42']);
        expect(toList(null)).toEqual([]);
        // 线上真实故障: location 写成字符串后 .join 不存在
        expect(toList('王城, 森林')).toEqual(['王城, 森林']);
    });

    it('toNumber: 非法值回退而不是变 NaN', () => {
        expect(toNumber('12', 0)).toBe(12);
        expect(toNumber('abc', 7)).toBe(7);
        expect(toNumber(undefined, 7)).toBe(7);
        expect(toNumber(null, 7)).toBe(7);
    });

    it('sanitizeEvent: 全脏字段也能产出合法形状', () => {
        const dirty = {
            id: 1001,
            level: '0',
            structured_kv: {
                causality: 42,
                event: 1024,
                location: '王城',
                logic: '对话',
                role: ['A', 7],
                time_anchor: 302,
            },
            summary: { broken: true },
            timestamp: 'not-a-number',
        };

        const clean = sanitizeEvent(dirty);

        expect(typeof clean.id).toBe('string');
        expect(typeof clean.summary).toBe('string');
        expect(typeof clean.timestamp).toBe('number');
        expect(Number.isNaN(clean.timestamp)).toBe(false);
        expect(clean.structured_kv.event).toBe('1024');
        expect(clean.structured_kv.location).toEqual(['王城']);
        expect(clean.structured_kv.logic).toEqual(['对话']);
        expect(clean.structured_kv.role).toEqual(['A', '7']);
        expect(clean.structured_kv.time_anchor).toBe('302');
    });

    it('sanitizeEvent: 没有 structured_kv 时补空壳而不是 undefined', () => {
        const clean = sanitizeEvent({ id: 'evt_1' });

        expect(clean.structured_kv).toBeDefined();
        expect(clean.structured_kv.location).toEqual([]);
        expect(clean.structured_kv.event).toBe('');
        expect(typeof clean.id).toBe('string');
    });

    it('sanitizeEntities: 丢弃非对象记录且不影响其余数据', () => {
        const dropped: unknown[] = [];
        const out = sanitizeEntities(
            [{ id: 'e1', name: 99, aliases: '别名' }, null, 'garbage'],
            bad => dropped.push(bad)
        );

        expect(out).toHaveLength(1);
        expect(out[0].name).toBe('99');
        expect(out[0].aliases).toEqual(['别名']);
        expect(dropped).toHaveLength(2);
    });
});
