import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '@/config/settings';
import { chatManager } from '@/data/ChatManager';
import { getDbForChat } from '@/data/db';
import { llmAdapter } from '@/integrations/llm/Adapter';
import { MacroService, WorldInfoService } from '@/integrations/tavern';
import { WorldBookSlotService } from '@/integrations/tavern/worldbook';
import { summarizerService } from '@/modules/memory/Summarizer';
import { BatchEngine } from '@/modules/batch/engine/BatchEngine';
import { embeddingService } from '@/modules/rag/embedding/EmbeddingService';
import { WorkflowEngine } from '@/modules/workflow/core/WorkflowEngine';
import { ApplyTrim } from '@/modules/workflow/steps/persistence/ApplyTrim';
import { SaveEntity } from '@/modules/workflow/steps/persistence/SaveEntity';
import { useMemoryStore } from '@/state/memoryStore';
import { notificationService } from '@/ui/services/NotificationService';

const response = {
    success: true,
    content: JSON.stringify({ events: [{ summary: '仅属于聊天 A 的记忆', meta: { event: 'A 的事件' } }] }),
};
let sequence = 0;
let chatId: string;
let settings: any;
let cancel: () => void;

function setChat(id: string, count = 20) {
    (window.SillyTavern.getContext as any).mockReturnValue({
        chatId: id,
        chat: Array.from({ length: count }, (_, i) => ({
            mes: `${id} 第 ${i + 1} 楼`,
            name: id,
            is_user: i % 2 === 0,
        })),
        characters: [],
        characterId: 1,
        name1: 'User',
        name2: id,
        extensionSettings: { engram: settings },
        saveSettingsDebounced: vi.fn(),
    });
}

function deferGeneration() {
    let finish!: (value: typeof response) => void;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
        enter = resolve;
    });
    vi.spyOn(llmAdapter, 'generate').mockImplementationOnce(() => {
        enter();
        return new Promise((resolve) => {
            finish = resolve;
        });
    });
    return { entered, finish: () => finish(response) };
}

beforeEach(async () => {
    vi.restoreAllMocks();
    chatId = `safety-${++sequence}`;
    (window.SillyTavern.getContext as any).mockReturnValue({ extensionSettings: {} });
    settings = structuredClone(SettingsManager.getSettings());
    settings.syncConfig = { enabled: false, autoSync: false };
    settings.globalPreviewEnabled = false;
    settings.apiSettings = null;
    settings.summarizerConfig = {};
    setChat(chatId);
    useMemoryStore.getState().reset();
    vi.spyOn(MacroService, 'refreshEngramCache').mockResolvedValue(undefined);
    vi.spyOn(MacroService, 'refreshCache').mockResolvedValue(undefined);
    vi.spyOn(WorldBookSlotService, 'init').mockResolvedValue(undefined);
    vi.spyOn(WorldInfoService, 'getScopes').mockReturnValue({ global: [], chat: [] } as any);
    vi.spyOn(notificationService, 'running').mockImplementation((_message, _title, onCancel) => {
        cancel = onCancel!;
        return null;
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('测试禁止真实网络请求')));
    await summarizerService.initializeForCurrentChat();
    summarizerService.updateConfig({
        enabled: true,
        floorInterval: 10,
        bufferSize: 0,
        autoHide: false,
        previewEnabled: false,
    });
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('总结的聊天隔离与取消', () => {
    it('模型返回前切换聊天时，不写入另一个聊天，也不修改其进度', async () => {
        const generation = deferGeneration();
        const task = summarizerService.triggerSummary(true, [1, 10]);
        await generation.entered;
        setChat(`${chatId}-B`);
        await useMemoryStore.getState().initChat();
        await summarizerService.initializeForCurrentChat();
        generation.finish();

        expect(await task).toBeNull();
        expect(await getDbForChat(chatId).events.count()).toBe(0);
        expect(await getDbForChat(`${chatId}-B`).events.count()).toBe(0);
        expect(await getDbForChat(`${chatId}-B`).meta.get('scope_state')).toBeUndefined();
        expect(summarizerService.getStatus().lastSummarizedFloor).toBe(0);
        expect(useMemoryStore.getState().recentEvents).toEqual([]);
    });

    it('在工作流启动前等待世界书时切换聊天，也会取消原任务', async () => {
        let release!: () => void;
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        vi.mocked(WorldBookSlotService.init).mockImplementationOnce(() => {
            enter();
            return new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const generate = vi.spyOn(llmAdapter, 'generate').mockResolvedValue(response);
        const task = summarizerService.triggerSummary(true, [1, 10]);
        await entered;
        setChat(`${chatId}-B`);
        release();

        expect(await task).toBeNull();
        expect(generate).not.toHaveBeenCalled();
        expect(await getDbForChat(`${chatId}-B`).events.count()).toBe(0);
    });

    it('取消模型请求后仍从未完成的楼层开始，事件和进度同步提交', async () => {
        const generation = deferGeneration();
        const task = summarizerService.triggerSummary(true, [1, 10]);
        await generation.entered;
        cancel();
        generation.finish();

        expect(await task).toBeNull();
        expect(await getDbForChat(chatId).events.count()).toBe(0);
        expect(summarizerService.getStatus().lastSummarizedFloor).toBe(0);

        vi.spyOn(llmAdapter, 'generate').mockResolvedValue(response);
        const next = await summarizerService.triggerSummary(true);
        expect(next?.sourceFloors).toEqual([1, 10]);
        const db = getDbForChat(chatId);
        expect((await db.events.toArray()).map((event) => event.source_range)).toEqual([
            { start_index: 1, end_index: 10 },
        ]);
        expect((await db.meta.get('scope_state'))?.value).toMatchObject({ chatId, last_summarized_floor: 10 });
    });

    it('提交成功后在刷新缓存时取消，下次仍从数据库中的真实进度继续', async () => {
        vi.spyOn(llmAdapter, 'generate').mockResolvedValue(response);
        vi.mocked(MacroService.refreshEngramCache).mockImplementationOnce(async () => { cancel(); });
        expect(await summarizerService.triggerSummary(true, [1, 10])).toBeNull();
        expect((await getDbForChat(chatId).meta.get('scope_state'))?.value).toMatchObject({ last_summarized_floor: 10 });
        const next = await summarizerService.triggerSummary(true);
        expect(next?.sourceFloors).toEqual([11, 20]);
        expect(await getDbForChat(chatId).events.count()).toBe(2);
    });

    it.each(['switch', 'cancel', 'failure'])('提交进度时发生 %s，事件和进度全部回滚', async (mode) => {
        vi.spyOn(llmAdapter, 'generate').mockResolvedValue(response);
        const updateState = chatManager.updateState.bind(chatManager);
        vi.spyOn(chatManager, 'updateState').mockImplementationOnce(async (partial, targetChatId) => {
            if (mode === 'failure') {
                throw new Error('模拟进度写入失败');
            }
            if (mode === 'switch') {
                setChat(`${chatId}-B`);
            } else {
                cancel();
            }
            await updateState(partial, targetChatId);
        });

        expect(await summarizerService.triggerSummary(true, [1, 10])).toBeNull();
        expect(await getDbForChat(chatId).events.count()).toBe(0);
        expect(await getDbForChat(chatId).meta.get('scope_state')).toBeUndefined();
        expect(await getDbForChat(`${chatId}-B`).events.count()).toBe(0);
        expect(await getDbForChat(`${chatId}-B`).meta.get('scope_state')).toBeUndefined();
        expect(useMemoryStore.getState().recentEvents).toEqual([]);
    });

    it('预先取消的任务不执行任何步骤', async () => {
        const execute = vi.fn();
        await expect(
            WorkflowEngine.run(
                { name: 'cancelled', steps: [{ name: 'first', execute }] },
                {
                    signal: { cancelled: true },
                },
            ),
        ).rejects.toMatchObject({ message: 'UserCancelled', isCancellation: true });
        expect(execute).not.toHaveBeenCalled();
    });

    it('最后一步请求结束时的取消也不能被 ignoreFailure 吞掉', async () => {
        const signal = { cancelled: false };
        await expect(
            WorkflowEngine.run(
                {
                    name: 'cancel-final',
                    steps: [
                        {
                            name: 'last',
                            ignoreFailure: true,
                            execute: async () => {
                                signal.cancelled = true;
                                return { action: 'finish' as const };
                            },
                        },
                    ],
                },
                { signal },
            ),
        ).rejects.toThrow('UserCancelled');
    });

    it('保存多条实体途中切换聊天，后续实体不会写入新聊天', async () => {
        const store = useMemoryStore.getState();
        const saveEntity = store.saveEntity;
        vi.spyOn(store, 'saveEntity').mockImplementationOnce(async (data) => {
            const saved = await saveEntity(data);
            setChat(`${chatId}-B`);
            return saved;
        });
        const context: any = {
            chatId,
            input: { _rawExistingEntities: [] },
            config: {},
            metadata: {},
            output: {
                newEntities: [
                    { name: '实体一', type: 'character' },
                    { name: '实体二', type: 'character' },
                ],
            },
        };
        await expect(new SaveEntity().execute(context)).rejects.toThrow('UserCancelled');
        expect(await getDbForChat(chatId).entities.count()).toBe(1);
        expect(await getDbForChat(`${chatId}-B`).entities.count()).toBe(0);
    });

    it('精简等待向量接口时切换聊天，不会归档新聊天中的同 ID 事件', async () => {
        const source: any = {
            id: 'shared-id',
            summary: '原记忆',
            level: 0,
            timestamp: 1000,
            significance_score: 0.5,
            is_archived: false,
            is_embedded: false,
            source_range: { start_index: 1, end_index: 10 },
            structured_kv: { role: [], logic: [], location: [] },
        };
        await getDbForChat(chatId).events.put(source);
        await getDbForChat(`${chatId}-B`).events.put(source);
        settings.apiSettings = { embeddingConfig: { enabled: true, trigger: 'with_trim' } };
        vi.spyOn(embeddingService, 'embedEvents').mockImplementationOnce(async () => {
            setChat(`${chatId}-B`);
            return { success: 1, failed: 0 };
        });
        const context: any = {
            chatId,
            input: { eventsToMerge: [source] },
            config: {},
            metadata: {},
            parsedData: { events: [{ summary: '合并后的记忆' }] },
        };
        await expect(new ApplyTrim().execute(context)).rejects.toThrow('UserCancelled');
        expect(await getDbForChat(`${chatId}-B`).events.get(source.id)).toMatchObject({
            is_archived: false,
            is_embedded: false,
        });
    });

    it('批处理切换聊天后不再开始下一批', async () => {
        const engine = new BatchEngine();
        let release!: () => void;
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        const started = vi.fn();
        const task = engine.execute({
            type: 'test',
            estimate: async () => [
                { id: 'batch', type: 'summary', status: 'pending', progress: { current: 0, total: 2 } },
            ],
            async *execute(_tasks, stopped) {
                for (let i = 0; i < 2; i++) {
                    if (stopped()) {
                        return;
                    }
                    started();
                    if (i === 0) {
                        enter();
                        await new Promise<void>((resolve) => {
                            release = resolve;
                        });
                    }
                    yield;
                }
            },
        });
        await entered;
        setChat(`${chatId}-B`);
        release();
        await task;
        expect(started).toHaveBeenCalledTimes(1);
        expect(engine.getQueueState().isRunning).toBe(false);
    });
});
