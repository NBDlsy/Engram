import type { SearchAdapter, SearchResult } from '../SearchService';
import { toText } from '@/data/utils/sanitize';
import { getCurrentChatId } from '@/integrations/tavern';
import { tryGetDbForChat } from '@/data/db';
import { Calendar, FileText } from 'lucide-react';

export class MemoryAdapter implements SearchAdapter {
    async search(query: string): Promise<SearchResult[]> {
        const lowerQuery = query.toLowerCase().trim();
        if (!lowerQuery || lowerQuery.length < 2) {return [];}

        const chatId = getCurrentChatId();
        if (!chatId) {return [];}

        const db = tryGetDbForChat(chatId);
        if (!db) {return [];}

        try {
            // Instant search on 'summary' field using basic string inclusion
            // For a real app, we might use a proper full-text index if Dexie supports it,
            // But for < 10k items, simple filtering might be acceptable for a prototype.
            // Limit to top 5 for speed in the palette.
            // Optimize: Scan from newest to oldest (timestamp) and stop after 5 matches
            // V1.5.2: Dexie Collection 没有 toReversed()（那是 Array 的 ES2023 方法），
            // 原写法会在运行期抛错，被下面的 catch 吞掉 → 记忆搜索永远返回空。
            const events = await db.events
                .orderBy('timestamp')
                .reverse()
                .filter(e => toText(e.summary).toLowerCase().includes(lowerQuery))
                .limit(5)
                .toArray();

            return events.map(e => ({
                id: `memory-${e.id}`,
                type: 'memory',
                title: e.summary.slice(0, 50) + (e.summary.length > 50 ? '...' : ''),
                description: new Date(e.timestamp).toLocaleString(),
                icon: FileText,
                action: (nav) => nav('/memory'), // TODO: Nav to specific item?
                score: 5, // Lower score than exact commands
            }));
        } catch (error) {
            console.error('Memory search failed', error);
            return [];
        }
    }
}
