import type { EventNode } from '@/data/types/graph';
import {
    deriveTimeAnchor,
    normalizeTrimResponse
} from '@/modules/workflow/steps/persistence/trimNormalizer';
import { describe, expect, it } from 'vitest';

const mkEvent = (id: string, summary: string, anchor: string, location: string[]): EventNode =>
    ({
        id,
        is_archived: false,
        is_embedded: false,
        level: 0,
        significance_score: 0.5,
        source_range: { end_index: 10, start_index: 1 },
        structured_kv: {
            causality: 'Chain',
            event: '测试',
            location,
            logic: ['逻辑A'],
            role: ['角色A'],
            time_anchor: anchor
        },
        summary,
        timestamp: 1000
    }) as unknown as EventNode;

const sources = [
    mkEvent('evt_1', '第一条摘要', '太阳历1023年春4月4日', ['森林']),
    mkEvent('evt_2', '第二条摘要', '太阳历1026年冬1月1日', ['王城'])
];

describe('normalizeTrimResponse', () => {
    it('标准结构: 读取 meta 内的字段', () => {
        const result = normalizeTrimResponse(
            {
                events: [
                    {
                        meta: {
                            causality: 'Chain',
                            event: '冒险初期',
                            location: ['森林', '王城'],
                            logic: ['成长'],
                            role: ['A', 'B'],
                            time_anchor: '太阳历1023年-1026年'
                        },
                        significance_score: 0.8,
                        summary: '合并后的摘要'
                    }
                ]
            },
            sources
        );

        expect(result.summary).toBe('合并后的摘要');
        expect(result.location).toEqual(['森林', '王城']);
        expect(result.timeAnchor).toBe('太阳历1023年-1026年');
        // V1.5.2: event / causality 不再被 ApplyTrim 写死，需从 meta 透传
        expect(result.event).toBe('冒险初期');
        expect(result.causality).toBe('Chain');
    });

    it('V1.5.2: 缺 meta 时 event / causality 返回空串，由调用方兜底', () => {
        const result = normalizeTrimResponse(
            { events: [{ significance_score: 0.8, summary: '平铺摘要' }] },
            sources
        );

        expect(result.event).toBe('');
        expect(result.causality).toBe('');
    });

    it('V1.5.2: event / causality 写成非字符串时不影响其余字段', () => {
        const result = normalizeTrimResponse(
            { events: [{ meta: { causality: 42, event: null, location: ['王城'] }, summary: 'x' }] },
            sources
        );

        expect(result.event).toBe('');
        expect(result.causality).toBe('');
        expect(result.location).toEqual(['王城']);
    });

    it('回归: 缺少 meta 包裹层不再抛 TypeError (原 ApplyTrim 崩溃场景)', () => {
        // 这正是线上报错 `Cannot read properties of undefined (reading 'location')` 的输入形态
        const broken = {
            events: [{ significance_score: 0.8, summary: '平铺的合并摘要' }]
        };

        expect(() => normalizeTrimResponse(broken, sources)).not.toThrow();

        const result = normalizeTrimResponse(broken, sources);
        expect(result.summary).toBe('平铺的合并摘要');
        // meta 缺失时回退为原事件的地点并集与时间范围
        expect(result.location).toEqual(['森林', '王城']);
        expect(result.timeAnchor).toBe('太阳历1023年春4月4日-太阳历1026年冬1月1日');
    });

    it('平铺字段: 顶层直接给 location / time_anchor 也能读到', () => {
        const result = normalizeTrimResponse(
            {
                events: [
                    {
                        location: ['酒馆'],
                        significance_score: 0.7,
                        summary: '平铺摘要',
                        time_anchor: '太阳历1030年'
                    }
                ]
            },
            sources
        );

        expect(result.location).toEqual(['酒馆']);
        expect(result.timeAnchor).toBe('太阳历1030年');
    });

    it('events 元素是纯字符串', () => {
        const result = normalizeTrimResponse({ events: ['纯文本摘要'] }, sources);

        expect(result.summary).toBe('纯文本摘要');
        expect(result.location).toEqual(['森林', '王城']);
    });

    it('location 写成字符串而非数组', () => {
        const result = normalizeTrimResponse(
            { events: [{ meta: { location: '边境公会' }, summary: 'x' }] },
            sources
        );

        expect(result.location).toEqual(['边境公会']);
    });

    it('events 元素类型非法时回退且不抛错', () => {
        expect(() => normalizeTrimResponse({ events: [null, 42, undefined] }, sources)).not.toThrow();

        const result = normalizeTrimResponse({ events: [null, 42] }, sources);
        expect(result.summary).toBe('第一条摘要\n\n第二条摘要');
        expect(result.location).toEqual(['森林', '王城']);
    });

    it('events 为空数组时走兜底', () => {
        const result = normalizeTrimResponse({ events: [] }, sources);

        expect(result.summary).toBe('第一条摘要\n\n第二条摘要');
    });
});

describe('deriveTimeAnchor', () => {
    it('单条事件直接返回其 time_anchor', () => {
        expect(deriveTimeAnchor([sources[0]])).toBe('太阳历1023年春4月4日');
    });

    it('多条事件拼成首尾范围', () => {
        expect(deriveTimeAnchor(sources)).toBe('太阳历1023年春4月4日-太阳历1026年冬1月1日');
    });

    it('无有效 time_anchor 时返回空串', () => {
        expect(deriveTimeAnchor([])).toBe('');
    });
});
