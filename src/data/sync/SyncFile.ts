import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

export type SyncMetadata = Record<string, any>;

/** 固定长度、全小写文件名；同时兼容不提供 Web Crypto 的 HTTP 酒馆。 */
export function getSyncFileName(chatId: string): string {
    return `Engram_sync2_${bytesToHex(sha256(chatId))}.json`;
}

export function getLegacySyncFileName(chatId: string): string {
    return `Engram_sync_${chatId.replaceAll(/[^a-zA-Z0-9_-]/g, '_')}.json`;
}

/** 旧名称也可能在大小写不敏感的文件系统上碰撞，归属必须由元数据证明。 */
export function needsLegacyConfirmation(chatId: string, meta: SyncMetadata, legacy: boolean): boolean {
    const identities = [meta.chatId, meta.scope_state?.chatId].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
    );
    if (identities.some((id) => id !== chatId)) {
        throw new Error('同步文件属于其他聊天，已阻止覆盖');
    }
    if (identities.length > 0) {
        return false;
    }
    if (!legacy) {
        throw new Error('同步文件缺少聊天标识，已阻止覆盖');
    }
    return true;
}

/** 只解析完整的顶层 meta 对象，避免命中实体字段或截断的时间戳。 */
function readLeadingMetadata(text: string): SyncMetadata | undefined {
    const prefix = /^\s*\{\s*"meta"\s*:\s*/.exec(text);
    if (!prefix || text[prefix[0].length] !== '{') {
        return undefined;
    }

    const start = prefix[0].length;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (quoted) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                quoted = false;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === '{') {
            depth++;
        } else if (char === '}' && --depth === 0) {
            return JSON.parse(text.slice(start, i + 1));
        }
    }
    return undefined;
}

export async function readSyncMetadata(response: Response): Promise<SyncMetadata> {
    const reader = response.body?.getReader();
    if (!reader) {
        return (await response.json()).meta || {};
    }

    const decoder = new TextDecoder();
    let text = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            text += decoder.decode(value, { stream: true });

            // 新文件的元数据位于开头，可提早终止；旧文件必须继续读取到结尾。
            if (text.length <= 102_400) {
                const meta = readLeadingMetadata(text);
                if (meta) {
                    await reader.cancel();
                    return meta;
                }
            }
        }
        text += decoder.decode();
        return JSON.parse(text).meta || {};
    } finally {
        reader.releaseLock();
    }
}
