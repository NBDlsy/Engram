import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteDatabase, exportChatData, getDbForChat } from '@/data/db';
import { syncService } from '@/data/sync/SyncService';

describe('sync state persistence', () => {
    const chatIds: string[] = [];

    afterEach(async () => {
        vi.unstubAllGlobals();
        for (const chatId of chatIds.splice(0)) {
            await deleteDatabase(chatId);
        }
    });

    it('tracks scope state changes in the sync timestamp', async () => {
        const chatId = `sync_state_${Date.now()}`;
        chatIds.push(chatId);
        const db = getDbForChat(chatId);

        await db.meta.put({
            key: 'scope_state',
            value: { last_summarized_floor: 42 },
        });
        await new Promise(resolve => setTimeout(resolve, 600));

        const lastModified = await db.meta.get('lastModified');
        expect(lastModified?.value).toEqual(expect.any(Number));
    });

    it('serializes meta before large event collections', async () => {
        const chatId = `sync_order_${Date.now()}`;
        chatIds.push(chatId);
        const db = getDbForChat(chatId);
        await db.meta.put({ key: 'lastModified', value: 123 });

        const dump = await exportChatData(db);

        expect(Object.keys(dump)).toEqual(['meta', 'events', 'entities']);
        expect(JSON.stringify(dump).indexOf('"meta"')).toBe(1);
    });

    it('reads the remote timestamp from the streamed file header', async () => {
        const payload = JSON.stringify({
            meta: { lastModified: 987 },
            events: [],
            entities: [],
        });
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(payload));
                controller.close();
            },
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));

        await expect(syncService.getRemoteStatus('sync_stream')).resolves.toEqual({
            exists: true,
            timestamp: 987,
        });
    });
});
