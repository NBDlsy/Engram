import { describe, expect, it, vi } from 'vitest';
import { retriever } from '@/modules/rag/retrieval/Retriever';

const mockDb = {
    events: {
        filter: vi.fn(),
        // rollingSearch 走 orderBy('timestamp').reverse()，需要一并 mock
        orderBy: vi.fn(),
        reverse: vi.fn(),
        limit: vi.fn(),
        toArray: vi.fn(),
        first: vi.fn(),
    },
    entities: {
        filter: vi.fn(),
        limit: vi.fn(),
        count: vi.fn(),
    },
};

vi.mock('@/integrations/tavern', () => ({
    getCurrentChatId: vi.fn(() => 'test-chat-id'),
}));

vi.mock('@/data/db', () => ({
    tryGetDbForChat: vi.fn(() => mockDb),
}));

vi.mock('@/config/settings', () => ({
    SettingsManager: {
        get: vi.fn(() => ({
            recallConfig: {
                enabled: true,
                useEmbedding: true,
                useRerank: false,
                usePreprocessing: false,
                useAgenticRAG: false,
                useKeywordRecall: true,
                enableEntityKeyword: true,
                enableEventKeyword: true,
                embedding: { topK: 5, minScoreThreshold: 0.35 },
            }
        })),
    },
}));

vi.mock('@/integrations/tavern/chat/chatHistory', () => ({
    ChatHistoryHelper: {
        getCurrentMessageCount: vi.fn(() => 10),
        getChatHistory: vi.fn(() => 'ctx'),
    }
}));

vi.mock('@/modules/workflow/core/WorkflowEngine', () => ({
    WorkflowEngine: {
        run: vi.fn(async () => ({
            output: { entries: ['ok'], nodes: [{ id: 'evt_x', summary: 'ok' }], candidates: [{ id: 'evt_x' }] },
            data: { recalledEntities: [], candidates: [{ id: 'evt_x' }] },
            metadata: { stepsExecuted: ['KeywordRetrieveStep'] },
        })),
    },
}));

vi.mock('@/modules/workflow/definitions/RetrievalWorkflow', () => ({
    createRetrievalWorkflow: vi.fn(() => ({ name: 'wf', steps: [] })),
}));

describe('Retriever cold-start guard', () => {
    it('should skip recall workflow when no vectorized and no archived entries', async () => {
        const eventFilterOnce = {
            limit: vi.fn().mockReturnThis(),
            count: vi.fn()
                .mockResolvedValueOnce(0) // embedded
                .mockResolvedValueOnce(0), // archived events
        };
        // rollingSearch 的链路: orderBy('timestamp').reverse().filter(...).limit().toArray() / .first()
        const eventRollingChain = {
            filter: vi.fn().mockReturnThis(),
            first: vi.fn().mockResolvedValue({ id: 'evt_macro', level: 1, summary: 'macro' }),
            limit: vi.fn().mockReturnThis(),
            toArray: vi.fn().mockResolvedValue([{ id: 'evt_roll', level: 0, summary: 'recent' }]),
        };
        mockDb.events.orderBy.mockReturnValue({
            reverse: vi.fn().mockReturnValue(eventRollingChain),
        });

        // 冷启动检查的两次计数走 filter().limit(1).count()
        mockDb.events.filter
            .mockReturnValueOnce(eventFilterOnce)
            .mockReturnValueOnce(eventFilterOnce);

        const entityFilter = {
            limit: vi.fn().mockReturnThis(),
            count: vi.fn().mockResolvedValue(0), // archived entities
        };
        mockDb.entities.filter.mockReturnValue(entityFilter);

        const result = await retriever.search('hello');

        expect(result.skippedReason).toBe('当前没有向量化或归档条目，已跳过召回流程');
        expect(result.nodes.length).toBeGreaterThan(0);

        // 回归保护: rollingSearch 必须用 Dexie 真实存在的 API。
        // 此前写的是 Collection.toReversed()（那是 Array 的 ES2023 方法），运行期抛
        // "toReversed is not a function"，被 catch 吞掉 → 冷启动保护静默失效。
        expect(mockDb.events.orderBy).toHaveBeenCalledWith('timestamp');
    });
});
