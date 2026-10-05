import { SettingsManager } from '@/config/settings';
import { eventTrimmer } from '@/modules/memory/EventTrimmer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 回归用例: EventTrimmer 的配置合并顺序
 *
 * 修复前，实例缓存的是一份**完整**配置，且优先级高于持久化设置，
 * 导致初始化之后 SettingsManager 里的改动永远读不到。
 */
describe('EventTrimmer 配置优先级', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        // 重置实例级 override（单例在模块加载时可能已被别处设置过）
        (eventTrimmer as any).overrides = {};
    });

    it('优先级应为: 默认值 < 持久化设置 < 实例 override', () => {
        vi.spyOn(SettingsManager, 'getSummarizerSettings').mockReturnValue({
            trimConfig: {
                enabled: true,
                keepRecentCount: 7,
                maxEventsPerTrim: 4
            }
        } as any);

        eventTrimmer.updateConfig({ enabled: false });

        const cfg = eventTrimmer.getConfig();
        expect(cfg.enabled).toBe(false);        // 实例 override 胜出
        expect(cfg.keepRecentCount).toBe(7);    // 持久化值生效（修复前会被缓存的默认值 3 遮蔽）
        expect(cfg.maxEventsPerTrim).toBe(4);
    });

    it('持久化设置变更后无需重建实例即可读到新值', () => {
        const spy = vi.spyOn(SettingsManager, 'getSummarizerSettings');

        spy.mockReturnValue({ trimConfig: { keepRecentCount: 2 } } as any);
        expect(eventTrimmer.getConfig().keepRecentCount).toBe(2);

        // 模拟用户在设置面板改动并保存
        spy.mockReturnValue({ trimConfig: { keepRecentCount: 9 } } as any);
        expect(eventTrimmer.getConfig().keepRecentCount).toBe(9);
    });

    it('未显式 override 的项应回落到默认值', () => {
        vi.spyOn(SettingsManager, 'getSummarizerSettings').mockReturnValue({
            trimConfig: {}
        } as any);

        const cfg = eventTrimmer.getConfig();
        expect(cfg.keepRecentCount).toBe(3);
        expect(cfg.maxEventsPerTrim).toBe(10);
    });
});
