import { SettingsManager } from '@/config/settings';
import { getDbForChat } from '@/data/db';
import type { EventNode } from '@/data/types/graph';
import { useMemoryStore } from '@/state/memoryStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatId = 'test_chat_agentic_index';

const mkEvent = (id: string, opts: Partial<EventNode> = {}): EventNode =>
    ({
        id,
        is_archived: false,
        is_embedded: false,
        is_locked: false,
        level: 0,
        significance_score: 0.5,
        source_range: { end_index: 9, start_index: 0 },
        structured_kv: {
            causality: 'Chain',
            event: '测试事件',
            location: ['森林'],
            logic: ['逻辑A'],
            role: ['角色A'],
            time_anchor: '太阳历1023年春4月4日'
        },
        summary: '摘要',
        timestamp: 1000,
        ...opts
    }) as unknown as EventNode;

describe('Agentic 索引', () => {
    beforeEach(async () => {
        vi.clearAllMocks();

        (window.SillyTavern.getContext as any).mockReturnValue({
            characterId: 1,
            characters: [],
            chat: [{ mes: 'hello' }],
            chatId
        });

        vi.spyOn(SettingsManager, 'get').mockImplementation((key: string) => {
            if (key === 'apiSettings') {return {};}
            if (key === 'summarizerConfig') {
                return { enabled: true, trimConfig: { enabled: false } };
            }
            return null;
        });

        const store = useMemoryStore.getState();
        await store.initChat();
        const db = getDbForChat(chatId);
        await db.events.clear();
    });

    it('record 带上 time_anchor 属性，供召回裁判按时间判断相关性', async () => {
        const db = getDbForChat(chatId);
        await db.events.put(mkEvent('evt_active_1'));
        await db.events.put(
            mkEvent('evt_archived_1', { is_archived: true, structured_kv: { ...mkEvent('x').structured_kv, time_anchor: '太阳历1000年冬1月1日' } })
        );

        const index = await useMemoryStore.getState().getAgenticIndex();

        expect(index).toContain('id="evt_active_1"');
        expect(index).toContain('time_anchor="太阳历1023年春4月4日"');
        expect(index).toContain('time_anchor="太阳历1000年冬1月1日"');
    });

    it('V1.5.2: 字段是脏值（数字/字符串/对象）时仍能构建索引', async () => {
        const db = getDbForChat(chatId);
        const dirty = mkEvent('evt_dirty');
        // 线上真实报错: e.replaceAll is not a function / role.join is not a function
        Object.assign(dirty.structured_kv, {
            causality: 42,
            event: 1024,
            location: '王城',           // 写成字符串而非数组
            role: ['A', 'B'],
            time_anchor: 302            // 数字
        });
        await db.events.put(dirty);

        const index = await useMemoryStore.getState().getAgenticIndex();

        expect(index).toContain('id="evt_dirty"');
        expect(index).toContain('event="1024"');
        expect(index).toContain('location="王城"');
        expect(index).toContain('role="A, B"');
    });

    it('time_anchor 缺失时不输出该属性，也不会崩', async () => {
        const db = getDbForChat(chatId);
        const broken = mkEvent('evt_no_time');
        // @ts-expect-error 刻意制造脏数据
        delete broken.structured_kv.time_anchor;
        await db.events.put(broken);

        const index = await useMemoryStore.getState().getAgenticIndex();

        expect(index).toContain('id="evt_no_time"');
        expect(index).not.toContain('time_anchor=');
    });
});
