import type { EventNode } from '@/data/types/graph';
import { filterEvents } from '@/ui/views/memory-stream/utils/streamProcessors';
import { describe, expect, it } from 'vitest';

const mkEvent = (id: string, kv: Record<string, unknown>, summary = '正常摘要'): EventNode =>
    ({
        id,
        is_archived: false,
        level: 0,
        structured_kv: kv,
        summary,
        timestamp: 1000,
    }) as unknown as EventNode;

const baseArgs = (events: EventNode[], query: string) =>
    [events, new Map(), query, false, new Set<string>(), 'asc'] as const;

describe('filterEvents 脏数据容错', () => {
    it('structured_kv.event 不是字符串时搜索不抛错', () => {
        // 线上报错: n.event?.toLowerCase is not a function
        const events = [
            mkEvent('evt_num', { event: 1024, location: ['王城'], role: ['A'] }),
            mkEvent('evt_arr', { event: ['穿越', '冒险'], location: ['森林'], role: ['B'] }),
            mkEvent('evt_ok', { event: '正常事件', location: ['酒馆'], role: ['C'] }),
        ];

        expect(() => filterEvents(...baseArgs(events, '穿越'))).not.toThrow();
        expect(() => filterEvents(...baseArgs(events, '正常'))).not.toThrow();
    });

    it('能对非字符串字段正常匹配', () => {
        const events = [mkEvent('evt_num', { event: 1024 }), mkEvent('evt_arr', { event: ['穿越'] })];

        expect(filterEvents(...baseArgs(events, '1024')).map(e => e.id)).toEqual(['evt_num']);
        expect(filterEvents(...baseArgs(events, '穿越')).map(e => e.id)).toEqual(['evt_arr']);
    });

    it('role 元素不是字符串也能搜索', () => {
        const events = [mkEvent('evt_role', { event: 'x', role: ['A', 123] })];

        expect(() => filterEvents(...baseArgs(events, '123'))).not.toThrow();
        expect(filterEvents(...baseArgs(events, '123')).length).toBe(1);
    });

    it('缺少 structured_kv 时不抛错', () => {
        const broken = { id: 'evt_broken', summary: '摘要', timestamp: 1 } as unknown as EventNode;

        expect(() => filterEvents(...baseArgs([broken], '摘要'))).not.toThrow();
    });
});
