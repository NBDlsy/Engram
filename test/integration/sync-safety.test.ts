import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '@/config/settings';
import { exportChatData, getDbForChat } from '@/data/db';
import { getLegacySyncFileName, getSyncFileName } from '@/data/sync/SyncFile';
import { syncService } from '@/data/sync/SyncService';

let settings: any;
let files: Map<string, string>;
let deleted: string[];
let sequence = 0;
let chatId: string;

function event(id: string, summary = id) {
    return {
        id,
        summary,
        timestamp: 1,
        level: 0,
        is_archived: false,
        is_embedded: false,
        significance_score: 0.5,
        source_range: { start_index: 1, end_index: 10 },
        structured_kv: { event: '事件', time_anchor: '', role: [], location: [], logic: [], causality: '' },
    };
}

async function seed(id: string, summary = '本地内容', timestamp = 1000) {
    const importing = vi.spyOn(syncService, 'isImportingChat').mockReturnValue(true);
    try {
        const db = getDbForChat(id);
        await db.events.put(event(`event-${id}`, summary));
        await db.meta.put({ key: 'lastModified', value: timestamp });
        return db;
    } finally {
        importing.mockRestore();
    }
}

function streamed(text: string, chunks?: string[]) {
    const data =
        chunks ||
        Array.from({ length: Math.ceil(text.length / 16384) }, (_, i) => text.slice(i * 16384, (i + 1) * 16384));
    let index = 0;
    return new Response(
        new ReadableStream({
            pull(controller) {
                if (index === data.length) {
                    controller.close();
                } else {
                    controller.enqueue(new TextEncoder().encode(data[index++]));
                }
            },
        }),
        { status: 200 },
    );
}

beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    chatId = `sync-safety-${++sequence}`;
    (window.SillyTavern.getContext as any).mockReturnValue({ extensionSettings: {} });
    settings = structuredClone(SettingsManager.getSettings());
    settings.syncConfig = { enabled: false, autoSync: false };
    (window.SillyTavern.getContext as any).mockReturnValue({
        chatId,
        chat: [],
        extensionSettings: { engram: settings },
    });
    files = new Map();
    deleted = [];
    class Reader {
        result = '';
        onload?: () => void;
        onerror?: () => void;
        readAsDataURL(blob: Blob) {
            void blob
                .arrayBuffer()
                .then((data) => {
                    this.result = `data:application/json;base64,${Buffer.from(data).toString('base64')}`;
                    this.onload?.();
                })
                .catch(() => this.onerror?.());
        }
    }
    vi.stubGlobal('FileReader', Reader);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
            if (input === '/api/files/upload') {
                const body = JSON.parse(init!.body as string);
                files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
                return new Response('{}', { status: 200 });
            }
            if (input === '/api/files/delete') {
                const body = JSON.parse(init!.body as string);
                deleted.push(body.path);
                files.delete(body.path);
                return new Response('{}', { status: 200 });
            }
            const name = new URL(String(input), 'http://test.local').pathname.split('/').at(-1)!;
            return files.has(name) ? streamed(files.get(name)!) : new Response(null, { status: 404 });
        }),
    );
});

afterEach(() => {
    settings.syncConfig = { enabled: false, autoSync: false };
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('同步数据隔离、旧文件兼容与大文件', () => {
    it('中文、大小写和长聊天名使用不同且长度受控的文件', async () => {
        const ids = [`${chatId}-甲`, `${chatId}-乙`, `${chatId}-A`, `${chatId}-a`, `${chatId}-${'长名称'.repeat(200)}`];
        for (const id of ids) {
            await seed(id, `记忆属于 ${id}`);
            expect(await syncService.upload(id)).toBe(true);
        }
        expect(files.size).toBe(ids.length);
        expect(new Set([...files.keys()].map((name) => name.toLowerCase())).size).toBe(ids.length);
        expect([...files.keys()].every((name) => name.length < 255)).toBe(true);
        for (const id of ids) {
            expect(await syncService.download(id)).toBe('success');
            expect((await getDbForChat(id).events.toArray())[0].summary).toBe(`记忆属于 ${id}`);
        }
    });

    it('新大文件的时间戳位于开头，分块读取也能正确识别', async () => {
        const db = await seed(chatId, 'x'.repeat(180000), 1234567890000);
        expect(await syncService.upload(chatId)).toBe(true);
        const dump = JSON.stringify(await exportChatData(db));
        expect(dump.indexOf('"lastModified"')).toBeLessThan(102400);
        expect(await syncService.getRemoteStatus(chatId)).toEqual({ exists: true, timestamp: 1234567890000 });
    });

    it('旧文件的 meta 在末尾且实体含同名字段时，仍读取真正的同步时间', async () => {
        files.set(
            getLegacySyncFileName(chatId),
            JSON.stringify({
                entities: [{ profile: { lastModified: 9999999999999 } }],
                events: [event('large', 'x'.repeat(180000))],
                meta: { lastModified: 1234567890000, scope_state: { chatId } },
            }),
        );
        expect(await syncService.getRemoteStatus(chatId)).toEqual({ exists: true, timestamp: 1234567890000 });
    });

    it('时间戳在分块边界被截断时，不返回部分数字', async () => {
        vi.mocked(fetch).mockResolvedValueOnce(
            streamed('', [
                '{"meta":{"lastModified":12345',
                `67890000,"chatId":${JSON.stringify(chatId)},"note":"包含 } 与转义 \\\""},"events":[],"entities":[]}`,
            ]),
        );
        expect(await syncService.getRemoteStatus(chatId)).toEqual({ exists: true, timestamp: 1234567890000 });
    });

    it('已标明归属的旧备份可自动恢复并迁移，原文件保留', async () => {
        const id = `${chatId}-中文`;
        const db = await seed(id);
        const legacyName = getLegacySyncFileName(id);
        files.set(
            legacyName,
            JSON.stringify({
                events: [event('remote', '旧版记忆')],
                entities: [],
                meta: { lastModified: 2000, scope_state: { chatId: id, last_summarized_floor: 10 } },
            }),
        );
        settings.syncConfig = { enabled: true, autoSync: true };
        await syncService.autoSyncDownload(id);
        expect((await db.events.toArray()).map((item) => item.id)).toEqual(['remote']);
        expect(files.has(getSyncFileName(id))).toBe(true);
        expect(files.has(legacyName)).toBe(true);
        expect(await syncService.getRemoteStatus(id)).toEqual({ exists: true, timestamp: 2000 });
    });

    it.each(['中文', 'Latin', 'legacy_name'])(
        '无法确认归属的旧备份不会自动覆盖，需核对内容后明确恢复：%s',
        async (suffix) => {
            const id = `${chatId}-${suffix}`;
            const db = await seed(id);
            files.set(
                getLegacySyncFileName(id),
                JSON.stringify({
                    events: [event('legacy', '待核对的内容')],
                    entities: [],
                    meta: { lastModified: 2000 },
                }),
            );
            settings.syncConfig = { enabled: true, autoSync: true };
            await syncService.autoSyncDownload(id);
            expect(await syncService.autoSync(id)).toBe('legacy_unverified');
            expect(await syncService.download(id)).toBe('legacy_unverified');
            expect(await syncService.download(id, () => false)).toBe('cancelled');
            expect((await db.events.toArray())[0].summary).toBe('本地内容');

            const confirm = vi.fn(() => true);
            expect(await syncService.download(id, confirm)).toBe('success');
            expect(confirm).toHaveBeenCalledWith(
                expect.objectContaining({ eventCount: 1, summaryPreview: '待核对的内容' }),
            );
            expect((await db.events.toArray())[0].id).toBe('legacy');
            expect((await db.meta.get('chatId'))?.value).toBe(id);
            expect(files.has(getSyncFileName(id))).toBe(true);
        },
    );

    it.each([false, true])('拒绝属于其他聊天的备份，legacy=%s', async (legacy) => {
        const db = await seed(chatId);
        files.set(
            legacy ? getLegacySyncFileName(chatId) : getSyncFileName(chatId),
            JSON.stringify({
                events: [event('other')],
                entities: [],
                meta: { chatId: '另一个聊天', lastModified: 2000 },
            }),
        );
        const confirm = vi.fn(() => true);
        expect(await syncService.download(chatId, confirm)).toBe('error');
        expect(confirm).not.toHaveBeenCalled();
        expect((await db.events.toArray())[0].summary).toBe('本地内容');
    });

    it('删除聊天时保留归属不明的旧文件，避免删除另一聊天的备份', async () => {
        const id = `${chatId}-中文`;
        files.set(
            getLegacySyncFileName(id),
            JSON.stringify({ events: [], entities: [], meta: { lastModified: 2000 } }),
        );
        await syncService.purge(id);
        expect(deleted).toEqual([getSyncFileName(id)]);
        expect(files.has(getLegacySyncFileName(id))).toBe(true);
    });

    it('回滚的事务不会更新时间戳或上传未提交的数据', async () => {
        const db = await seed(chatId);
        const schedule = vi.spyOn(syncService, 'scheduleUpload');
        settings.syncConfig = { enabled: true, autoSync: true };
        await expect(
            db.transaction('rw', db.events, async () => {
                await db.events.update(`event-${chatId}`, { summary: '必须撤销的内容' });
                throw new Error('取消事务');
            }),
        ).rejects.toThrow('取消事务');
        await vi.advanceTimersByTimeAsync(4000);
        expect((await db.events.toArray())[0].summary).toBe('本地内容');
        expect((await db.meta.get('lastModified'))?.value).toBe(1000);
        expect(schedule).not.toHaveBeenCalled();
        expect(files.size).toBe(0);
    });

    it.each([{ summary: '编辑后的记忆' }, { is_archived: true }, { is_embedded: true, embedding: [0.1, 0.2] }])(
        '已有事件变更会更新时间戳并上传：%j',
        async (updates) => {
            const db = await seed(chatId);
            settings.syncConfig = { enabled: true, autoSync: true };
            const schedule = vi.spyOn(syncService, 'scheduleUpload');
            await db.events.update(`event-${chatId}`, updates);
            await vi.advanceTimersByTimeAsync(600);
            await vi.waitFor(() => expect(schedule).toHaveBeenCalledWith(chatId));
            expect((await db.meta.get('lastModified'))?.value).not.toBe(1000);
            await vi.advanceTimersByTimeAsync(3100);
            await vi.waitFor(() => expect(files.has(getSyncFileName(chatId))).toBe(true));
            expect(JSON.parse(files.get(getSyncFileName(chatId))!).events[0]).toMatchObject(updates);
        },
    );
});
