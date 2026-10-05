import type { EntityNode, EventNode } from '@/data/types/graph';

/**
 * V1.5.2 脏数据净化层
 *
 * 背景：库里存在字段类型与声明不符的数据（LLM 输出漂移 / 旧版本写入 / 导入的外部库）。
 * 典型故障：
 *   - `structured_kv.event` 被写成数字 → `.toLowerCase is not a function`
 *   - `structured_kv.role` 被写成字符串 → `.join is not a function`
 *   - `summary` 被写成对象 → `.split is not a function` / React 渲染 "Objects are not valid as a React child"
 *   - `timestamp` 缺失 → `new Date(undefined)` 分组、排序全乱
 *
 * 之前是在每个消费点打 `?.` 补丁，漏一个就整块白屏。改为在**读取数据库的唯一出口**
 * 一次性净化，消费点拿到的永远是合法形状。
 */

/** 任意值 → 可安全参与字符串运算的文本 */
export function toText(value: unknown): string {
    if (typeof value === 'string') {return value;}
    if (typeof value === 'number' || typeof value === 'boolean') {return String(value);}
    if (Array.isArray(value)) {return value.map(toText).join(' ');}
    if (value === null || value === undefined) {return '';}
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value);
        } catch {
            return '';
        }
    }
    return String(value);
}

/** 任意值 → 字符串数组（字符串按单元素处理，而非逐字符拆开） */
export function toList(value: unknown): string[] {
    if (value === null || value === undefined) {return [];}
    if (Array.isArray(value)) {
        return value
            .filter(v => v !== null && v !== undefined && v !== '')
            .map(v => toText(v))
            .filter(Boolean);
    }
    const text = toText(value).trim();
    return text ? [text] : [];
}

/** 任意值 → 数字，非法/缺失时回退（注意 Number(null) === 0，必须先挡掉） */
export function toNumber(value: unknown, fallback = 0): number {
    if (value === null || value === undefined || value === '') {return fallback;}
    const n = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(n) ? n : fallback;
}

/** 任意值 → 布尔 */
export function toBool(value: unknown): boolean {
    return value === true || value === 1 || value === 'true';
}

/**
 * 净化单个事件节点。只做「补形状」，不动业务内容：
 * 有值就尽量保留（转成字符串/数组），没值就填安全空值。
 */
export function sanitizeEvent(event: unknown): EventNode {
    const raw = (event ?? {}) as Partial<EventNode> & Record<string, unknown>;
    const kv = (raw.structured_kv ?? raw.meta ?? {}) as Record<string, unknown>;

    return {
        ...raw,
        id: toText(raw.id) || `evt_broken_${Math.random().toString(36).slice(2, 10)}`,
        summary: toText(raw.summary),
        timestamp: toNumber(raw.timestamp, Date.now()),
        level: toNumber(raw.level, 0),
        significance_score: toNumber(raw.significance_score, 0),
        is_archived: toBool(raw.is_archived),
        is_locked: toBool(raw.is_locked),
        is_embedded: toBool(raw.is_embedded),
        structured_kv: {
            time_anchor: toText(kv.time_anchor),
            role: toList(kv.role),
            location: toList(kv.location),
            event: toText(kv.event),
            logic: toList(kv.logic),
            causality: toText(kv.causality),
        },
    } as unknown as EventNode;
}

/** 净化单个实体节点 */
export function sanitizeEntity(entity: unknown): EntityNode {
    const raw = (entity ?? {}) as Partial<EntityNode> & Record<string, unknown>;

    return {
        ...raw,
        id: toText(raw.id) || `ent_broken_${Math.random().toString(36).slice(2, 10)}`,
        name: toText(raw.name) || '未命名实体',
        type: (toText(raw.type) || 'unknown') as EntityNode['type'],
        aliases: toList(raw.aliases),
        description: toText(raw.description),
        profile: (raw.profile && typeof raw.profile === 'object' && !Array.isArray(raw.profile))
            ? raw.profile as Record<string, unknown>
            : {},
        last_updated_at: toNumber(raw.last_updated_at, Date.now()),
    } as unknown as EntityNode;
}

/**
 * 批量净化 + 丢弃不可用记录。
 * `onDrop` 用于把被丢弃的数据写进日志，避免"数据凭空消失"无法排查。
 */
export function sanitizeEvents(events: unknown[], onDrop?: (bad: unknown, reason: string) => void): EventNode[] {
    const out: EventNode[] = [];
    for (const e of events ?? []) {
        if (!e || typeof e !== 'object') {
            onDrop?.(e, '不是对象');
            continue;
        }
        out.push(sanitizeEvent(e));
    }
    return out;
}

export function sanitizeEntities(entities: unknown[], onDrop?: (bad: unknown, reason: string) => void): EntityNode[] {
    const out: EntityNode[] = [];
    for (const e of entities ?? []) {
        if (!e || typeof e !== 'object') {
            onDrop?.(e, '不是对象');
            continue;
        }
        out.push(sanitizeEntity(e));
    }
    return out;
}
