import { Logger } from '@/core/logger';
import { RobustJsonParser } from '@/core/utils/JsonParser';
import type { JobContext } from '../../core/JobContext';
import type { IStep } from '../../core/Step';

export class ParseJson implements IStep {
    name = 'ParseJson';

    async execute(context: JobContext): Promise<void> {
        // V0.9.1: 优先使用 CleanRegex 清洗后的内容
        const contentToparse = context.cleanedContent
            || context.llmResponse?.content;

        if (!contentToparse) {
            throw new Error('ParseJson: 无 LLM 响应内容');
        }

        const parsed = RobustJsonParser.parse<any>(contentToparse);


        if (!parsed) {
            // V1.5.2: 只抛一句话没法定位。这里把原始输出的首尾快照打出来，
            // 一眼区分「模型根本没输出 JSON」「JSON 被截断」「被输出正则洗坏了」三种情况。
            const raw = context.llmResponse?.content ?? '';
            const trimmed = contentToparse.trim();
            const looksTruncated = trimmed.length > 0
                && !trimmed.endsWith('}')
                && !trimmed.endsWith(']');

            Logger.error('ParseJson', 'JSON 解析失败，原始输出快照', {
                cleanedUsed: Boolean(context.cleanedContent),
                looksTruncated,
                parseTargetHead: trimmed.slice(0, 500),
                parseTargetLength: contentToparse.length,
                parseTargetTail: trimmed.slice(-200),
                rawHead: raw.slice(0, 200),
                rawLength: raw.length,
                // 清洗前后长度差过大，通常是输出正则规则误伤
                regexShrink: context.cleanedContent ? raw.length - context.cleanedContent.length : 0
            });

            throw new Error('ParseJson: JSON 解析失败');
        }

        // 防御性校验：如果解析出的对象包含 events 字段，确保它是数组
        if (parsed.events !== undefined && !Array.isArray(parsed.events)) {
            Logger.warn('ParseJson', 'events 字段不是数组，尝试修正', { type: typeof parsed.events });
            parsed.events = [];
        }

        context.parsedData = parsed;
        Logger.debug('ParseJson', 'JSON 解析成功');
    }
}
