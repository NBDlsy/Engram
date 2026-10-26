import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/settings', () => ({
    SettingsManager: {
        getSettings: vi.fn(),
        incrementStatistic: vi.fn(),
    },
}));
vi.mock('@/integrations/tavern', () => ({
    getCurrentCharacter: vi.fn(() => null),
    getCurrentModel: vi.fn(() => 'tavern-model'),
}));
vi.mock('@/core/utils', () => ({
    generateShortUUID: () => 'wf_errors',
    sleep: (delay: number) => new Promise(resolve => setTimeout(resolve, delay)),
}));

import { SettingsManager } from '@/config/settings';
import { Logger } from '@/core/logger';
import { ModelLogger } from '@/core/logger/ModelLogger';
import { llmAdapter } from '@/integrations/llm/Adapter';
import { WorkflowEngine } from '@/modules/workflow/core/WorkflowEngine';
import { LlmRequest } from '@/modules/workflow/steps/execution/LlmRequest';

describe('LLM request failure handling', () => {
    const generateRaw = vi.fn();
    const downstream = vi.fn();

    function run(presetId?: string, signal?: { cancelled: boolean }) {
        return WorkflowEngine.run(
            {
                name: 'ErrorWorkflow',
                steps: [
                    {
                        name: 'Prompt',
                        async execute(context) {
                            context.prompt = { system: 'system', user: 'user', presetId };
                        },
                    },
                    new LlmRequest(),
                    { name: 'Persistence', execute: downstream },
                ],
            },
            { signal }
        );
    }

    beforeEach(async () => {
        await import('@/modules/workflow/steps/processing/RegexProcessor');
        vi.useFakeTimers();
        vi.clearAllMocks();
        generateRaw.mockReset();
        ModelLogger.clear();
        (global as any).window.TavernHelper = { generateRaw };
        vi.mocked(SettingsManager.getSettings).mockReturnValue({
            apiSettings: {
                selectedPresetId: 'selected',
                llmPresets: [
                    { id: 'first', source: 'tavern', retryConfig: { maxAttempts: 1, retryDelay: 1 } },
                    { id: 'selected', source: 'tavern', retryConfig: { maxAttempts: 2, retryDelay: 100 } },
                    {
                        id: 'bound',
                        source: 'custom',
                        stream: true,
                        custom: { apiSource: 'openai', apiUrl: 'https://example.invalid', apiKey: 'private-key', model: 'bound-model' },
                        parameters: { maxTokens: 60000 },
                        retryConfig: { maxAttempts: 3, retryDelay: 200 },
                    },
                ],
            },
        } as any);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('retries Conflict with the selected preset, then continues on success', async () => {
        generateRaw.mockRejectedValueOnce(new Error('Conflict')).mockResolvedValueOnce('ok');
        const pending = run();
        await vi.advanceTimersByTimeAsync(99);
        expect(generateRaw).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const context = await pending;
        expect(context.llmResponse?.content).toBe('ok');
        expect(generateRaw).toHaveBeenCalledTimes(2);
        expect(ModelLogger.getAll().filter(entry => entry.direction === 'received')).toHaveLength(2);
    });

    it('honors template-bound retry limits and exponential backoff', async () => {
        generateRaw.mockRejectedValue(new Error('HTTP 409: Conflict'));
        const pending = expect(run('bound')).rejects.toThrow('HTTP 409');
        await vi.advanceTimersByTimeAsync(199);
        expect(generateRaw).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(generateRaw).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(400);
        await pending;
        expect(generateRaw).toHaveBeenCalledTimes(3);
        expect(downstream).not.toHaveBeenCalled();
    });

    it.each(['Bad Request', 'HTTP 400: invalid timeout parameter'])('does not retry %s or reach persistence', async message => {
        generateRaw.mockRejectedValue(new Error(message));
        await expect(run('bound')).rejects.toThrow('接口拒绝请求');
        expect(generateRaw).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
        expect(ModelLogger.getAll().filter(entry => entry.direction === 'received')).toHaveLength(1);
        const diagnostic = vi.mocked(Logger.error).mock.calls.find(call => call[0] === 'LLMAdapter')?.[2];
        expect(diagnostic).toMatchObject({ presetId: 'bound', model: 'bound-model', stream: true });
        expect(JSON.stringify(diagnostic)).not.toContain('private-key');
        expect(JSON.stringify(diagnostic)).not.toContain('https://example.invalid');
    });

    it('stops retries when cancelled during backoff', async () => {
        generateRaw.mockRejectedValue(new Error('Conflict'));
        const signal = { cancelled: false };
        const pending = expect(run('bound', signal)).rejects.toThrow('UserCancelled');
        await vi.advanceTimersByTimeAsync(100);
        signal.cancelled = true;
        await vi.advanceTimersByTimeAsync(100);
        await pending;
        expect(generateRaw).toHaveBeenCalledTimes(1);
        expect(downstream).not.toHaveBeenCalled();
    });

    it('shares preset resolution between generation and retries', () => {
        expect(llmAdapter.resolvePreset('missing')?.id).toBe('selected');
        expect(new LlmRequest().retry.maxAttempts).toBe(2);
        vi.mocked(SettingsManager.getSettings).mockReturnValue({ apiSettings: { llmPresets: [] } } as any);
        expect(llmAdapter.resolvePreset()).toBeUndefined();
        expect(new LlmRequest().retry.maxAttempts).toBe(3);
    });

    it('keeps legacy static retry configurations working', async () => {
        const execute = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(undefined);
        const pending = WorkflowEngine.run(
            {
                name: 'LegacyRetry',
                steps: [{ name: 'Legacy', execute, retry: { maxAttempts: 2, delay: 10 } }],
            },
            {}
        );
        await vi.advanceTimersByTimeAsync(10);
        await pending;
        expect(execute).toHaveBeenCalledTimes(2);
    });
});
