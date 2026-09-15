import type { IStep } from '../../core/Step';
import type { JobContext } from '../../core/JobContext';
import type { EventNode } from '@/data/types/graph';
import { Logger } from '@/core/logger';
import { useMemoryStore } from '@/state/memoryStore';

/**
 * V1.5.2: 背景概览的最大字符数。
 * 概览只是补充上下文（真正的待合并内容在 {{targetSummaries}}），
 * 不设限的话它会随事件积压线性增长，把精简 prompt 重新撑爆。
 * 超限后保留**最近**的部分——对"当前剧情背景"而言近期信息更有价值。
 */
const MAX_BACKGROUND_CHARS = 8000;

export class FormatTrimInput implements IStep {
    name = 'FormatTrimInput';

    async execute(context: JobContext): Promise<void> {
        if (context.data?.skipTrimming) {
            return;
        }

        const events = context.input.eventsToMerge as EventNode[];
        if (!events || events.length === 0) {
            throw new Error('FormatTrimInput: 未找到事件');
        }

        const formattedText = events.map(e => {
            const kv = e.structured_kv;
            // V1.0.2: location 现在是数组
            const locStr = Array.isArray(kv.location) ? kv.location.join(', ') : kv.location;
            return `${e.summary}
Role: [${kv.role.join(', ')}]
Loc: [${locStr}]
Event: ${kv.event}
Logic: [${kv.logic.join(', ')}]
Causality: ${kv.causality}
Significance: ${e.significance_score}`;
        }).join('\n\n---\n\n');

        // 将格式化后的文本放入变量
        // V1.2.1: 使用 targetSummaries 存储待精简内容，避免覆盖全局 engramSummaries
        context.input.targetSummaries = formattedText;
        context.input.eventsText = formattedText; // 兼容旧名称
        context.input.text = formattedText; // 兼容 {{userInput}}
        context.input.eventCount = events.length.toString();

        // V1.5.2: 显式提供 {{engramSummaries}} 背景，排除本次待合并的条目。
        // 该宏默认由酒馆 worldbook 槽位注入全量活跃事件，必然包含待合并项，
        // 导致同一批事件在 prompt 里出现两次（概览区 + 待合并区），白白翻倍长度。
        // BuildPrompt 会优先使用 context.input 里的值，故这里覆盖掉宏注入。
        context.input.engramSummaries = await this.buildBackground(events);

        Logger.debug('FormatTrimInput', `格式化完成 (${formattedText.length} chars)`);
    }

    /**
     * V1.5.2: 构建去重后的背景概览
     *
     * 口径对齐 getEventSummaries（已精简的 level>=1 大纲 + 未归档事件），
     * 但剔除本次待合并的条目，避免与 {{targetSummaries}} 重复。
     * 失败时返回空串，不阻断精简流程。
     */
    private async buildBackground(batch: EventNode[]): Promise<string> {
        try {
            const batchIds = new Set(batch.map(e => e.id));
            const store = useMemoryStore.getState();
            const all = await store.getAllEvents();

            const lines = all
                .filter(e => !batchIds.has(e.id))
                .filter(e => e.level >= 1 || !e.is_archived)
                .sort((a, b) => a.timestamp - b.timestamp)
                .map(e => e.summary)
                .filter(Boolean);

            if (lines.length === 0) {return '';}

            let text = `<summary>\n${lines.join('\n\n')}\n</summary>`;

            if (text.length > MAX_BACKGROUND_CHARS) {
                // 从最早的事件开始丢弃，保留最近的部分
                const kept: string[] = [];
                let size = 0;
                for (let i = lines.length - 1; i >= 0; i--) {
                    if (size + lines[i].length > MAX_BACKGROUND_CHARS) {break;}
                    size += lines[i].length;
                    kept.unshift(lines[i]);
                }
                text = `<summary>\n${kept.join('\n\n')}\n</summary>`;
                Logger.debug('FormatTrimInput', `背景概览超限已截断`, {
                    dropped: lines.length - kept.length,
                    maxChars: MAX_BACKGROUND_CHARS,
                    total: lines.length
                });
            }

            Logger.debug('FormatTrimInput', `背景概览已去重 (${lines.length} 条, ${text.length} chars)`);
            return text;
        } catch (error) {
            Logger.warn('FormatTrimInput', '构建背景概览失败，回退为空', { error });
            return '';
        }
    }
}
