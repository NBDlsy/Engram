import { SettingsManager } from '@/config/settings';
import { Logger } from '@/core/logger';
import type { EventNode } from '@/data/types/graph';
import { MacroService } from '@/integrations/tavern';
import { embeddingService } from '@/modules/rag';
import { useMemoryStore } from '@/state/memoryStore';
import { notificationService } from '@/ui/services/NotificationService';
import type { JobContext } from '../../core/JobContext';
import type { IStep } from '../../core/Step';
import { normalizeTrimResponse } from './trimNormalizer';

export class ApplyTrim implements IStep {
    name = 'ApplyTrim';

    async execute(context: JobContext): Promise<void> {
        if (context.data?.skipTrimming) {
            return;
        }

        const store = useMemoryStore.getState();
        const eventsToMerge = (context.input.eventsToMerge as EventNode[]) || [];

        if (eventsToMerge.length === 0) {
            throw new Error('ApplyTrim: 待合并事件为空，无法精简');
        }

        // Output from ParseJson (TrimResponse structure)
        // V1.2.2: 优先从 context.parsedData 读取，对齐 ParseJson 逻辑
        const parsed = context.parsedData || context.output;

        if (!parsed || !parsed.events || parsed.events.length === 0) {
            throw new Error('ApplyTrim: 无有效的精简结果');
        }

        // V1.5.2: 归一化 LLM 输出，兼容 meta 缺失 / 平铺字段 / 字符串元素
        const normalized = normalizeTrimResponse(parsed, eventsToMerge);

        // 1. 保存新的合并事件
        const newEvent = await store.saveEvent({
            is_archived: false,
            is_embedded: false,
            level: 1,  // 标记为二层精简
            // V1.5: 时空归一化核心，抢占它所有子节点中最老的一个时间点并再提前 1 毫秒，确立绝对统领排序位置
            significance_score: Math.max(...eventsToMerge.map(e => e.significance_score ?? 0)),
            source_range: {
                end_index: Math.max(...eventsToMerge.map(e => e.source_range?.end_index ?? 0)),
                start_index: Math.min(...eventsToMerge.map(e => e.source_range?.start_index ?? 0))
            },
            structured_kv: {
                // V1.5.2: 之前写死 'Chain' / '精简合并'，合并事件在记忆流里无法分辨，
                // 现在优先采用 LLM 的判断，缺失时才回退到旧的固定值。
                causality: normalized.causality || 'Chain',
                event: normalized.event || '精简合并',
                location: normalized.location,
                logic: this.mergeArrays(eventsToMerge.map(e => e.structured_kv?.logic ?? [])),
                role: this.mergeArrays(eventsToMerge.map(e => e.structured_kv?.role ?? [])),
                time_anchor: normalized.timeAnchor
            },
            summary: normalized.summary,
            timestamp: Math.min(...eventsToMerge.map(e => e.timestamp)) - 1
        });

        // 2. 联动嵌入 (Trim Linkage)
        const sourceEventIds = eventsToMerge.map(e => e.id);
        const settings = SettingsManager.get('apiSettings');
        // @ts-expect-error
        const embeddingConfig = settings?.embeddingConfig;

        if (embeddingConfig?.enabled && embeddingConfig.trigger === 'with_trim') {
            Logger.info('ApplyTrim', '触发联动嵌入', { count: eventsToMerge.length });
            try {
                // V1.2.2: 初始化 Embedding 服务配置，防止联动时配置丢失
                const vectorConfig = settings?.vectorConfig;
                if (vectorConfig) {
                    embeddingService.setConfig(vectorConfig);
                }

                await embeddingService.embedEvents(eventsToMerge);
                await store.markEventsAsEmbedded(sourceEventIds);
            } catch (embedError) {
                Logger.error('ApplyTrim', '联动嵌入失败', { error: embedError });
                notificationService.warning('联动嵌入失败，但精简已完成', 'Engram');
            }
        }

        // 3. 归档原始事件
        await store.archiveEvents(sourceEventIds);

        // 4. 刷新缓存
        await MacroService.refreshCache();

        Logger.success('ApplyTrim', '精简完成', {
            merged: eventsToMerge.length,
            newEventId: newEvent.id
        });

        context.output = {
            deletedCount: 0,
            newEvent,
            sourceEventIds
        };
    }

    private mergeArrays(arrays: string[][]): string[] {
        const set = new Set<string>();
        for (const arr of arrays) {
            if (!Array.isArray(arr)) {continue;}
            for (const item of arr) {
                if (typeof item === 'string' && item.trim().length > 0) {
                    set.add(item);
                }
            }
        }
        return [...set];
    }
}
