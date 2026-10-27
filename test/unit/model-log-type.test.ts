import { MODEL_LOG_TYPES, ModelLogger, normalizeLogType } from '@/core/logger/ModelLogger';
import { describe, expect, it } from 'vitest';

describe('模型日志 type 归一', () => {
    it("'trimming' 映射为 'trim'（EventTrimmer 此前一直传错）", () => {
        // 线上故障: 传 'trimming' → ModelLog 视图 TYPE_LABELS['trimming'] 为 undefined
        // → 读 .color 抛 "Cannot read properties of undefined (reading 'color')"
        // → 打开模型日志直接「组件加载失败」
        expect(normalizeLogType('trimming')).toBe('trim');
    });

    it("'generation' 归为 'other'（LlmRequest 的旧默认值不在契约内）", () => {
        expect(normalizeLogType('generation')).toBe('other');
    });

    it('非法值 / 缺失统一落 other，不抛错', () => {
        expect(normalizeLogType(undefined)).toBe('other');
        expect(normalizeLogType(null)).toBe('other');
        expect(normalizeLogType(42)).toBe('other');
        expect(normalizeLogType('不存在的类型')).toBe('other');
    });

    it('合法值原样保留', () => {
        for (const t of MODEL_LOG_TYPES) {
            expect(normalizeLogType(t)).toBe(t);
        }
    });

    it('回归: 用错误 type 写入后，落库的一定是合法值', () => {
        const id = ModelLogger.logSend({ type: 'trimming' as any, model: 'test' });
        const entry = ModelLogger.getPaired().find(p => p.sent.id === id)?.sent;

        expect(entry).toBeDefined();
        expect(entry?.type).toBe('trim');
        expect(MODEL_LOG_TYPES).toContain(entry!.type);
    });
});
