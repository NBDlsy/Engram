import { LogModule } from '@/core/logger';
import type { WorkflowDefinition } from '../core/WorkflowEngine';
import {
    BuildPrompt,
    CleanRegex,
    FetchContext,
    LlmRequest,
    SaveEvent,
    StopGeneration,
    UserReview
} from '../steps';

export const createSummaryWorkflow = (): WorkflowDefinition => ({
    logModule: LogModule.MEMORY_SUMMARY,
    name: 'SummaryWorkflow',
    steps: [
        new StopGeneration(),
        new FetchContext(),
        new BuildPrompt({ category: 'summary' }),
        new LlmRequest(),
        new CleanRegex('output'),
        new UserReview({
            title: '剧情摘要修订',
            type: 'summary'
        }),
        new SaveEvent()
    ]
});
