import type { IStep } from '../../core/Step';
import type { JobContext } from '../../core/JobContext';
import { useMemoryStore } from '@/state/memoryStore';
import { Logger } from '@/core/logger';
import type { EventNode } from '@/data/types/graph';

export class FetchEventsToTrim implements IStep {
    name = 'FetchEventsToTrim';

    async execute(context: JobContext): Promise<void> {
        const config = context.config || {};
        const keepRecentCount = config.keepRecentCount || 3;

        const store = useMemoryStore.getState();
        const pending = await store.getEventsToMerge(keepRecentCount);

        // V1.5.2: 分批合并。积压过多时只取最老的一批，避免 prompt 过长导致
        // LLM 输出跑偏（历史上曾因此丢掉 meta 包裹层，直接搞崩 ApplyTrim）。
        const maxEventsPerTrim = config.maxEventsPerTrim || 10;
        const eventsToMerge = pending.length > maxEventsPerTrim
            ? pending.slice(0, maxEventsPerTrim)
            : pending;

        if (pending.length > maxEventsPerTrim) {
            Logger.debug('FetchEventsToTrim', `积压 ${pending.length} 条，本次仅合并最老的 ${maxEventsPerTrim} 条`);
        }

        if (eventsToMerge.length < 2) {
            // 逻辑决定是throw还是warn。通常如果手动触发，应该throw明确告知。
            if (context.trigger === 'manual') {
                throw new Error('待合并的事件不足 (需要至少 2 条)');
            } else {
                Logger.debug('FetchEventsToTrim', '事件不足，无需精简');
                // 可以设置一个标志让后续步骤跳过
                context.data = context.data || {};
                context.data.skipTrimming = true;
            }
        }

        context.input.eventsToMerge = eventsToMerge;
        context.data = context.data || {};
        context.data.sourceEventIds = eventsToMerge.map((e: EventNode) => e.id);

        Logger.debug('FetchEventsToTrim', `获取了 ${eventsToMerge.length} 条待合并事件`);
    }
}
