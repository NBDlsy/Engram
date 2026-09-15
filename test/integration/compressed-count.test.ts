import { SettingsManager } from '@/config/settings';
import { getDbForChat } from '@/data/db';
import type { EventNode } from '@/data/types/graph';
import { useMemoryStore } from '@/state/memoryStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatId = 'test_chat_compressed_count';

const mkEvent = (id: string, level: number, isArchived = false): EventNode =>
    ({
        id,
        is_archived: isArchived,
        is_embedded: false,
        is_locked: false,
        level,
        significance_score: 0.5,
        source_range: { end_index: 10, start_index: 1 },
        structured_kv: {
            causality: 'Chain',
            event: '测试',
            location: ['王城'],
            logic: ['逻辑A'],
            role: ['角色A'],
            time_anchor: '太阳历1023年'
        },
        summary: `摘要 ${id}`,
        timestamp: 1000
    }) as unknown as EventNode;

describe('countCompressedEvents (level 索引统计)', () => {
    beforeEach(async () => {
        (window.SillyTavern.getContext as any).mockReturnValue({
            characterId: 1,
            characters: [],
            chat: [{ mes: 'hello' }],
            chatId
        });
        vi.spyOn(SettingsManager, 'get').mockImplementation((key: string) =>
            key === 'apiSettings' ? {} : null);

        const store = useMemoryStore.getState();
        await store.initChat();
        await getDbForChat(chatId).events.clear();
    });

    it('只统计 level>=1，与旧的「拉全表再过滤」结果一致', async () => {
        const db = getDbForChat(chatId);
        await db.events.bulkPut([
            mkEvent('evt_l0_a', 0),
            mkEvent('evt_l0_b', 0),
            mkEvent('evt_l0_c', 0),
            mkEvent('evt_l1_a', 1),
            mkEvent('evt_l1_arch', 1, true),   // 归档的也算已精简
            mkEvent('evt_l2_a', 2),
        ]);

        const store = useMemoryStore.getState();

        const indexedCount = await store.countCompressedEvents();
        const legacyCount = (await store.getAllEvents()).filter(e => e.level >= 1).length;

        // l1_a、l1_arch、l2_a 共 3 条
        expect(indexedCount).toBe(3);
        expect(indexedCount).toBe(legacyCount);
    });

    it('没有已精简条目时返回 0', async () => {
        const db = getDbForChat(chatId);
        await db.events.bulkPut([mkEvent('evt_only_l0', 0)]);

        expect(await useMemoryStore.getState().countCompressedEvents()).toBe(0);
    });

    it('level 缺失的脏数据按 0 处理，不会被算进去', async () => {
        const db = getDbForChat(chatId);
        const noLevel = { ...mkEvent('evt_nolevel', 0) } as any;
        delete noLevel.level;
        await db.events.bulkPut([noLevel, mkEvent('evt_l1', 1)]);

        expect(await useMemoryStore.getState().countCompressedEvents()).toBe(1);
    });
});
