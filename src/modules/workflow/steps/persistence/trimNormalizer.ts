import { Logger } from '@/core/logger';
import type { EventNode } from '@/data/types/graph';

/**
 * TrimNormalizer - 精简结果的 Schema 归一化
 *
 * V1.5.2 新增。背景：
 * ParseJson 只校验 `events` 是否为数组，不做元素级 schema 校验；
 * RobustJsonParser 只负责"提取 + parse"，也不做结构修复。
 * 于是 LLM 一旦不严格套 `meta` 包裹层，脏数据就会直达 ApplyTrim 并抛
 * `Cannot read properties of undefined (reading 'location')`。
 *
 * 本模块把这些容错逻辑抽成纯函数，保证 ApplyTrim 永不因脏数据崩溃，且可单测。
 */

export interface NormalizedTrimResult {
    /**
     * 因果关联。V1.5.2: 之前 ApplyTrim 一律写死 'Chain'，
     * 于是所有合并事件在记忆流里长得一模一样，这里改为优先采用 LLM 的判断。
     */
    causality: string;
    /**
     * 事件主题。V1.5.2: 之前写死 '精简合并'，导致合并事件无法分辨；
     * 现在取 LLM 给的概括主题（如「穿越初期至冒险起步」），缺失时由调用方兜底。
     */
    event: string;
    /** 地点列表（已去重） */
    location: string[];
    /** 合并后的摘要 */
    summary: string;
    /** 时间锚点 */
    timeAnchor: string;
}

const pickString = (value: unknown): string =>
    typeof value === 'string' && value.trim().length > 0 ? value : '';

/**
 * V1.5.2: 按别名依次取值。
 * 模型跑偏时会自造字段名：正文写作 `description` / `content` / `text`，
 * 时间写作 `date` / `datetime` / `time_range`。逐个试，取第一个非空字符串。
 */
const SUMMARY_KEYS = ['summary', 'description', 'content', 'text', 'detail', 'narrative'];
const TIME_KEYS = ['time_anchor', 'time', 'date', 'datetime', 'time_range', 'date_range'];
const EVENT_KEYS = ['event', 'title', 'topic', 'theme'];

const pickFirst = (source: any, keys: string[]): string => {
    for (const key of keys) {
        const hit = pickString(source?.[key]);
        if (hit) {return hit;}
    }
    return '';
};

/**
 * V1.5.2: 清理事件主题。
 * 模型习惯在主题后面挂一段括号解释（如「晨间对话 (源于……，引发了……)」），
 * 这段会原样进 structured_kv.event 并作为记忆流的卡片标题，长到没法看。
 * 只在「括号后还有内容、且括号前是合理短语」时截断，避免误伤正常标题。
 */
const cleanEventTitle = (value: string): string => {
    const match = /^(.{4,80}?)\s*[（(]/.exec(value);
    return match ? match[1].trim() : value;
};

/** 截断快照，便于在日志里直接看出 LLM 究竟返回了什么形状 */
const snapshot = (value: unknown, max = 300): string => {
    try {
        const text = JSON.stringify(value);
        return typeof text === 'string' && text.length > max ? `${text.slice(0, max)}…` : (text ?? String(value));
    } catch {
        return String(value);
    }
};

/** 合并多个字符串数组并去重，跳过非法项 */
const mergeArrays = (arrays: unknown[]): string[] => {
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
};

/** 把任意值转成非空字符串数组（支持 "A, B" / ["A"] / "A"） */
const toStringArray = (value: unknown): string[] => {
    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed.length > 0 ? [trimmed] : [];
    }
    return mergeArrays([value]);
};

/** 用原始事件的 time_anchor 首尾拼出时间范围 */
export const deriveTimeAnchor = (eventsToMerge: EventNode[]): string => {
    const anchors = eventsToMerge
        .map(e => pickString(e?.structured_kv?.time_anchor))
        .filter((s): s is string => Boolean(s));

    if (anchors.length === 0) {return '';}
    if (anchors.length === 1) {return anchors[0];}

    const first = anchors[0];
    const last = anchors[anchors.length - 1];
    return first === last ? first : `${first}-${last}`;
};

/** 完全无法从 LLM 结果中提取时的兜底：用原始事件拼接 */
const fallback = (eventsToMerge: EventNode[]): NormalizedTrimResult => ({
    causality: '',
    event: '',
    location: mergeArrays(eventsToMerge.map(e => e?.structured_kv?.location)),
    summary: eventsToMerge.map(e => e?.summary ?? '').filter(Boolean).join('\n\n'),
    timeAnchor: deriveTimeAnchor(eventsToMerge)
});

/**
 * 归一化 LLM 返回的精简结果
 *
 * 兼容的跑偏情形：
 *  1. 不套 meta 包裹层，字段平铺在事件对象顶层
 *  2. events 数组元素是纯字符串
 *  3. meta 被写成 metadata 等别名
 *  4. location 写成字符串而非数组
 *  5. 整个 events 元素类型非法（数字 / null / undefined）
 */
export const normalizeTrimResponse = (
    parsed: any,
    eventsToMerge: EventNode[]
): NormalizedTrimResult => {
    const rawEvents: unknown[] = Array.isArray(parsed?.events) ? parsed.events : [];

    // 1. 过滤出可用元素（对象或字符串），其余丢弃
    const usable = rawEvents.filter(
        (e): e is any => typeof e === 'string' || (e !== null && typeof e === 'object')
    );

    if (usable.length === 0) {
        Logger.warn('ApplyTrim', '精简结果元素类型非法，回退为原文拼接', {
            raw: snapshot(rawEvents),
            types: rawEvents.map(e => typeof e)
        });
        return fallback(eventsToMerge);
    }

    // 2. summary: 字符串元素本身就是摘要；对象元素按别名取（summary → description → …）
    const summaries = usable
        .map(e => (typeof e === 'string' ? e : pickFirst(e, SUMMARY_KEYS)))
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

    // 3. meta 源: 优先第一个带 meta 对象的元素，其次退化为元素本身（兼容平铺字段）
    const withMeta = usable.find(
        e => e !== null && typeof e === 'object' && e.meta && typeof e.meta === 'object'
    );
    const metaSource: any = withMeta
        ? withMeta.meta
        : (usable.find(e => typeof e === 'object') ?? {});

    if (!withMeta) {
        Logger.warn('ApplyTrim', '精简结果缺少 meta 包裹层，已尝试平铺字段兜底', {
            keys: Object.keys(metaSource),
            raw: snapshot(usable[0])
        });
    }

    // 4. location 归一化；缺失时回退为原事件地点并集
    let location = toStringArray(metaSource?.location ?? metaSource?.locations);
    if (location.length === 0) {
        location = mergeArrays(eventsToMerge.map(e => e?.structured_kv?.location));
    }

    // 5. time_anchor（兼容 date / datetime 等别名）
    const timeAnchor = pickFirst(metaSource, TIME_KEYS) || deriveTimeAnchor(eventsToMerge);

    // 6. event（兼容 title / topic 等别名，并去掉模型附加的括号解释）
    const event = cleanEventTitle(pickFirst(metaSource, EVENT_KEYS));

    if (!pickString(metaSource?.summary)) {
        Logger.warn('ApplyTrim', '精简结果未使用 summary 字段，已按别名兜底', {
            summaryKeys: SUMMARY_KEYS.filter(k => k in metaSource),
            timeKey: TIME_KEYS.find(k => pickString(metaSource?.[k])) ?? '(缺失)',
            eventKey: EVENT_KEYS.find(k => pickString(metaSource?.[k])) ?? '(缺失)'
        });
    }

    return {
        causality: pickString(metaSource?.causality),
        event,
        location,
        summary: summaries.length > 0 ? summaries.join('\n\n') : fallback(eventsToMerge).summary,
        timeAnchor
    };
};
