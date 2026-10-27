import Dexie, { type Table } from 'dexie';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { EventNode } from '@/data/types/graph';

vi.mock('@/integrations/tavern', () => ({ getCurrentChatId: () => 'search-regression' }));
vi.mock('@/data/db', () => ({ tryGetDbForChat: () => db }));

import { MemoryAdapter } from '@/modules/search/adapters/MemoryAdapter';

const db = new Dexie('Engram_search_regression') as Dexie & { events: Table<EventNode, string> };
db.version(1).stores({ events: 'id, timestamp' });

describe('命令面板记忆搜索使用真实 Dexie 集合', () => {
    beforeAll(async () => {
        await db.events.bulkPut(Array.from({ length: 7 }, (_, index) => ({
            id: `evt_${index}`,
            timestamp: index,
            summary: `王城事件 ${index}`,
        } as EventNode)));
    });
    afterAll(async () => { await db.delete(); });

    it('从最新记录开始返回最多五条匹配记忆', async () => {
        const result = await new MemoryAdapter().search('王城');
        expect(result.map(item => item.id)).toEqual([
            'memory-evt_6', 'memory-evt_5', 'memory-evt_4', 'memory-evt_3', 'memory-evt_2',
        ]);
    });
});
