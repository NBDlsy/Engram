import { SettingsManager } from '@/config/settings';
import { getDbForChat } from '@/data/db';
import type { EventNode } from '@/data/types/graph';
import { llmAdapter } from '@/integrations/llm/Adapter';
import { MacroService } from '@/integrations/tavern';
import { eventTrimmer } from '@/modules/memory/EventTrimmer';
import { useMemoryStore } from '@/state/memoryStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/llm/Adapter', () => ({
    llmAdapter: {
        generate: vi.fn(),
        generateRaw: vi.fn()
    }
}));

const mkEvent = (i: number): EventNode =>
    ({
        id: `evt_seed_${i}`,
        is_archived: false,
        is_embedded: false,
        is_locked: false,
        level: 0,
        significance_score: 0.4 + i * 0.1,
        source_range: { end_index: i * 10 + 9, start_index: i * 10 },
        structured_kv: {
            causality: 'Chain',
            event: `事件${i}`,
            location: [`地点${i}`],
            logic: ['逻辑A'],
            role: [`角色${i}`],
            time_anchor: `太阳历102${i}年`
        },
        summary: `第 ${i} 条摘要`,
        timestamp: 1000 + i
    }) as unknown as EventNode;

describe('TrimmerWorkflow 集成: LLM 输出不合规时不崩溃', () => {
    const chatId = 'test_chat_trim';

    beforeEach(async () => {
        vi.clearAllMocks();

        (window.SillyTavern.getContext as any).mockReturnValue({
            characterId: 1,
            characters: [],
            chat: [{ mes: 'hello' }],
            chatId
        });

        vi.spyOn(SettingsManager, 'get').mockImplementation((key: string) => {
            if (key === 'summarizerConfig') {
                return {
                    enabled: true,
                    trimConfig: {
                        enabled: true,
                        keepRecentCount: 1,
                        maxEventsPerTrim: 10,
                        trigger: 'count',
                        countLimit: 2
                    }
                };
            }
            if (key === 'apiSettings') {return {};}
            return null;
        });

        // ApplyTrim 收尾会刷新酒馆宏缓存，node 环境下无 DOM，直接短路
        vi.spyOn(MacroService, 'refreshCache').mockResolvedValue(undefined);

        const store = useMemoryStore.getState();
        await store.initChat();

        const db = getDbForChat(chatId);
        await db.events.clear();

        eventTrimmer.updateConfig({ enabled: true, keepRecentCount: 1 });
    });

    it('缺少 meta 包裹层时仍能完成精简并归档原始事件', async () => {
        const db = getDbForChat(chatId);
        for (const e of [mkEvent(1), mkEvent(2), mkEvent(3), mkEvent(4)]) {
            await db.events.put(e);
        }

        // 线上崩溃的原始输入形态: events[0] 没有 meta
        (llmAdapter.generate as any).mockResolvedValue({
            success: true,
            content: '{"events": [{"summary": "合并后的摘要", "significance_score": 0.8}]}'
        });

        const result = await eventTrimmer.trim(true);

        expect(result).not.toBeNull();
        expect(result?.newEvent.summary).toBe('合并后的摘要');
        expect(result?.sourceEventIds.length).toBeGreaterThanOrEqual(2);

        // 4 条种子事件 + keepRecentCount=1 → 合并最老的 3 条，最新 1 条保留不归档
        const seeded = await db.events.where('id').startsWith('evt_seed_').toArray();
        expect(seeded.length).toBe(4);
        expect(seeded.filter(e => e.is_archived).map(e => e.id).sort()).toEqual([
            'evt_seed_1',
            'evt_seed_2',
            'evt_seed_3'
        ]);
        expect(seeded.find(e => e.id === 'evt_seed_4')?.is_archived).toBe(false);

        // 新生成的合并事件应为 level 1，且地点回退为原事件并集
        const merged = await db.events.filter(e => e.level >= 1).toArray();
        expect(merged.length).toBe(1);
        expect(merged[0].structured_kv.location.length).toBeGreaterThan(0);
        expect(merged[0].structured_kv.time_anchor).not.toBe('');
    });

    it('events 元素为纯字符串时仍能完成精简', async () => {
        const db = getDbForChat(chatId);
        for (const e of [mkEvent(1), mkEvent(2), mkEvent(3)]) {
            await db.events.put(e);
        }

        (llmAdapter.generate as any).mockResolvedValue({
            success: true,
            content: '{"events": ["纯文本摘要"]}'
        });

        const result = await eventTrimmer.trim(true);

        expect(result).not.toBeNull();
        expect(result?.newEvent.summary).toBe('纯文本摘要');
    });
});
