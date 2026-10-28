/**
 * ChatManager - V0.6 Multi-Database Architecture
 *
 * Manages the current chat context.
 * Each chat_id has its own database, so we just need to track the current chatId.
 */

import { Logger } from '@/core/logger';
import { type ChatDatabase, type ChatMeta, getDbForChat } from './db';
import { getCurrentCharacter, getCurrentChatId } from '@/integrations/tavern';
import { DEFAULT_SCOPE_STATE, type ScopeState } from './types/graph';

/** Meta 表中的状态 key */
const STATE_KEY = 'scope_state';
const CHARACTER_KEY = 'character_name';
const MODULE = 'ChatManager';

class ChatManager {
    private currentChatId: string | null = null;
    private currentDb: ChatDatabase | null = null;

    /**
     * 获取当前聊天的数据库实例
     * 自动从酒馆上下文获取 chat_id 并连接数据库
     */
    getCurrentDb(): ChatDatabase | null {
        const chatId = getCurrentChatId();
        if (!chatId) {
            Logger.warn(MODULE, '无法获取 chat_id，上下文可能未就绪');
            return null;
        }

        // 如果 chatId 变化，切换数据库连接
        if (chatId !== this.currentChatId) {
            this.currentChatId = chatId;
            this.currentDb = getDbForChat(chatId);
            Logger.debug(MODULE, `切换数据库: Engram_${chatId}`);
        }

        return this.currentDb;
    }

    /**
     * 获取当前 chatId
     */
    getCurrentChatId(): string | null {
        return getCurrentChatId();
    }

    /**
     * 获取显示用的角色名
     */
    getCharacterName(): string {
        return getCurrentCharacter()?.name || 'Unknown';
    }

    /**
     * 获取当前聊天的状态
     */
    async getState(chatId?: string): Promise<ScopeState> {
        const db = chatId ? getDbForChat(chatId) : this.getCurrentDb();
        if (!db) {return DEFAULT_SCOPE_STATE;}

        try {
            const meta = await db.meta.get(STATE_KEY);
            if (meta?.value) {
                return { ...DEFAULT_SCOPE_STATE, ...(meta.value as ScopeState) };
            }
            return DEFAULT_SCOPE_STATE;
        } catch (error) {
            Logger.error(MODULE, '获取状态失败:', error);
            return DEFAULT_SCOPE_STATE;
        }
    }

    /**
     * 更新当前聊天的状态
     */
    async updateState(partialState: Partial<ScopeState>, chatId?: string): Promise<void> {
        const db = chatId ? getDbForChat(chatId) : this.getCurrentDb();
        if (!db) {return;}

        try {
            // 使用同一个数据库读取和写入，避免 await 期间聊天切换。
            const meta = await db.meta.get(STATE_KEY);
            const newState = {
                ...DEFAULT_SCOPE_STATE,
                ...(meta?.value as Partial<ScopeState> | undefined),
                ...partialState,
                chatId: db.name.slice('Engram_'.length),
            };
            await db.meta.put({ key: STATE_KEY, value: newState });
        } catch (error) {
            Logger.error(MODULE, '更新状态失败:', error);
            throw error;
        }
    }

    /**
     * 保存角色名到当前数据库（用于 UI 显示）
     */
    async saveCharacterName(): Promise<void> {
        const db = this.getCurrentDb();
        if (!db) {return;}

        const name = this.getCharacterName();
        await db.meta.put({ key: CHARACTER_KEY, value: name });
    }

    /**
     * 获取数据库中保存的角色名
     */
    async getSavedCharacterName(): Promise<string> {
        const db = this.getCurrentDb();
        if (!db) {return 'Unknown';}

        const meta = await db.meta.get(CHARACTER_KEY);
        return (meta?.value as string) || 'Unknown';
    }

    /**
     * 重置状态（调试用）
     */
    async resetState(): Promise<void> {
        const db = this.getCurrentDb();
        if (!db) {return;}

        await db.meta.put({ key: STATE_KEY, value: DEFAULT_SCOPE_STATE });
    }
}

export const chatManager = new ChatManager();

/**
 * @deprecated V0.6: 使用 chatManager 替代
 * 保留以便定位迁移点
 */
const scopeManager = chatManager;
