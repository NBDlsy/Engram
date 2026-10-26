import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/config/settings', () => ({
    SettingsManager: {
        getSettings: vi.fn(() => ({
            apiSettings: {
                llmPresets: [],
                selectedPresetId: undefined,
            },
        })),
        incrementStatistic: vi.fn(),
    },
}));

import { SettingsManager } from '@/config/settings';
import { llmAdapter } from '@/integrations/llm/Adapter';

describe('LLMAdapter empty response handling', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (global as any).window.TavernHelper = {
            generateRaw: vi.fn().mockResolvedValue('   '),
        };
    });

    it('treats whitespace-only generateRaw output as failure', async () => {
        const response = await llmAdapter.generate({
            systemPrompt: 'system',
            userPrompt: 'user',
        });

        expect(response.success).toBe(false);
        expect(response.error).toContain('空响应');
        expect(SettingsManager.incrementStatistic).not.toHaveBeenCalled();
    });

    it('keeps non-empty output as success', async () => {
        const expected = 'non-empty-response';
        (global as any).window.TavernHelper = {
            generateRaw: vi.fn().mockResolvedValue(expected),
        };

        const response = await llmAdapter.generate({
            systemPrompt: 'system',
            userPrompt: 'user',
        });

        expect(response).toEqual(
            expect.objectContaining({
                content: expected,
                success: true,
            })
        );
        expect(SettingsManager.incrementStatistic).toHaveBeenCalled();
    });
});
