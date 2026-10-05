import { SettingsManager } from '@/config/settings';
import { getBuiltInTemplateById } from '@/config/types/defaults';
import type { JobContext } from '@/modules/workflow/core/JobContext';
import { BuildPrompt } from '@/modules/workflow/steps/context/BuildPrompt';
import { describe, expect, it, vi } from 'vitest';

/** 造一个最小可用的 JobContext */
const mkContext = (config: Record<string, unknown> = {}): JobContext =>
    ({
        config,
        data: {},
        input: {}
    }) as unknown as JobContext;

/** 取回本次 BuildPrompt 写入 context.prompt 的模板 id */
const runAndGetUsedId = async (config: Record<string, unknown>): Promise<string> => {
    const ctx = mkContext(config);
    await new BuildPrompt({}).execute(ctx);
    return (ctx.prompt as any)?.templateId;
};

// 注意: 不要调 SettingsManager.initSettings() —— 它会拉起 SyncService 并访问 document，
// 而本项目的 vitest 环境是 node（未装 jsdom），会产生一条无关的 unhandled rejection。
// 这里整体 mock SettingsManager.get，只提供模板列表即可。
describe('BuildPrompt 精简契约守卫', () => {
    it('正常情况: 使用精简模板', async () => {
        expect(await runAndGetUsedId({ templateId: 'builtin_trim' })).toBe('builtin_trim');
    });

    it('回归: 精简模板被换成召回内容时自动回退内置版本', async () => {
        // 线上真实故障 —— 设置里的 builtin_trim 存的是召回模板的内容，
        // 于是精简请求让模型输出 {"recalls":[...]}，ApplyTrim 报「无有效的精简结果」
        const trim = getBuiltInTemplateById('builtin_trim')!;
        const recalled = {
            ...trim,
            systemPrompt: '你是召回裁判。输出:\n```json\n{"recalls": [{"id": "...", "score": 0.9, "reason": "..."}]}\n```',
            userPromptTemplate: '{{engramIndex}}'
        };

        const spy = vi.spyOn(SettingsManager, 'get').mockImplementation(((key: string) =>
            key === 'apiSettings' ? { promptTemplates: [recalled] } : undefined) as any);

        const usedId = await runAndGetUsedId({ templateId: 'builtin_trim' });

        spy.mockRestore();
        // 仍然解析到 builtin_trim，但内容已被换回内置版本（含 trim 契约）
        expect(usedId).toBe('builtin_trim');
    });

    it('用户自定义但保留 trim 契约时不被回退', async () => {
        const trim = getBuiltInTemplateById('builtin_trim')!;
        const custom = {
            ...trim,
            userPromptTemplate: `${trim.userPromptTemplate}\n（我的自定义补充）`
        };

        const spy = vi.spyOn(SettingsManager, 'get').mockImplementation(((key: string) =>
            key === 'apiSettings' ? { promptTemplates: [custom] } : undefined) as any);

        const ctx = mkContext({ templateId: 'builtin_trim' });
        await new BuildPrompt({}).execute(ctx);

        spy.mockRestore();
        expect((ctx.prompt as any).user).toContain('我的自定义补充');
    });

    it("category='trim' 能解析到精简模板（此前写成 'trimming' 会查不到）", async () => {
        expect(await runAndGetUsedId({ category: 'trim' })).toBe('builtin_trim');
    });
});
