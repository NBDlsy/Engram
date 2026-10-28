import { LogModule, Logger } from '@/core/logger';
import { getRequestHeaders, getSTContext } from '@/integrations/tavern';
import type { ChatDataDump} from '@/data/db';
import { getDbForChat, exportChatData, importChatData } from '@/data/db';
import { debounce } from 'lodash';
import { SettingsManager } from '@/config/settings';
import { notificationService } from '@/ui/services/NotificationService';
import { getSyncFileName, getLegacySyncFileName, needsLegacyConfirmation, readSyncMetadata } from './SyncFile';

const MODULE = LogModule.DATA_SYNC;
const DEBOUNCE_DELAY = 3000;

export interface LegacySyncPreview {
    fileName: string;
    eventCount: number;
    entityCount: number;
    summaryPreview: string;
}

type ConfirmLegacySync = (preview: LegacySyncPreview) => boolean | Promise<boolean>;

class SyncService {
    private static instance: SyncService;
    private debouncedUploads = new Map<string, () => void>();
    private importingChats = new Map<string, number>();

    public get isImportingState(): boolean {
        return this.importingChats.size > 0;
    }

    public isImportingChat(chatId: string): boolean {
        return this.importingChats.has(chatId);
    }

    private constructor() {
        Logger.info(MODULE, `Initialized SyncService`);
        this.initEventListeners();
    }

    private initEventListeners() {
        // 动态导入 EventBus 以避免循环依赖（如果 EventBus 依赖其他模块）
        // 这里假设 EventBus 是独立的或我们延迟绑定
        // 为确保安全，我们在第一次 getInstance 时不强依赖 Tavern 上下文，
        // 而是依靠外部调用 init 或在构造函数中尝试
        setTimeout(async () => {
            const { EventBus, TavernEventType } = await import('@/integrations/tavern');

            // 监听聊天切换事件
            EventBus.on(TavernEventType.CHAT_CHANGED, async () => {
                const { getSTContext } = await import('@/integrations/tavern');
                const chatId = getSTContext()?.chatId;
                if (chatId) {
                    Logger.info(MODULE, `Chat changed to ${chatId}, checking sync...`);
                    // 延迟一点等待 DB 准备好
                    setTimeout(() => this.autoSyncDownload(chatId), 1000);
                }
            });

            // 首次加载也检查一次
            const { getSTContext } = await import('@/integrations/tavern');
            const initialChatId = getSTContext()?.chatId;
            if (initialChatId) {
                this.autoSyncDownload(initialChatId);
            }

            // P1 Fix: 增加可见性监听，实现“重回焦点即检查同步”
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') {
                    const currentChatId = getSTContext()?.chatId;
                    if (currentChatId) {
                        Logger.debug(MODULE, 'Tab became visible, checking sync...');
                        this.autoSyncDownload(currentChatId);
                    }
                }
            });
        }, 2000);
    }

    public static getInstance(): SyncService {
        if (!SyncService.instance) {
            SyncService.instance = new SyncService();
        }
        return SyncService.instance;
    }

    /**
     * 获取同步文件的完整 URL (用于 fetch)
     */
    private getSyncFileUrl(fileName: string): string {
        // 酒馆上传的文件在 /user/files/ 目录下
        // 添加时间戳防止缓存
        return `/user/files/${fileName}?t=${Date.now()}`;
    }

    /** 仅在新文件不存在时回退旧名称；请求错误不得伪装成旧数据。 */
    private async fetchRemoteFile(chatId: string) {
        const candidates = [getSyncFileName(chatId), getLegacySyncFileName(chatId)];
        for (const [index, fileName] of candidates.entries()) {
            const response = await fetch(this.getSyncFileUrl(fileName));
            if (response.status === 404) {
                await response.body?.cancel();
                continue;
            }
            if (!response.ok) {throw new Error(`同步读取失败: HTTP ${response.status}`);}
            return { response, fileName, legacy: index === 1 };
        }
        return null;
    }

    /**
     * 调度自动上传（防抖）
     */
    public scheduleUpload(chatId: string) {
        // 检查导入锁
        if (this.isImportingChat(chatId)) {
            Logger.debug(MODULE, `Skipping upload schedule for ${chatId} (Importing)`);
            return;
        }

        // 检查配置
        const config = SettingsManager.getSettings().syncConfig;
        if (!config?.enabled || !config?.autoSync) {
            return;
        }

        if (!this.debouncedUploads.has(chatId)) {
            const uploadFn = debounce(() => {
                // 再次检查配置，防止在 debounce 期间被关闭
                const currentConfig = SettingsManager.getSettings().syncConfig;
                if (!currentConfig?.enabled || !currentConfig?.autoSync) {
                    return;
                }

                this.upload(chatId).catch(error => {
                    Logger.error(MODULE, `Auto-upload failed for ${chatId}`, error);
                });
            }, DEBOUNCE_DELAY);
            this.debouncedUploads.set(chatId, uploadFn);
        }

        const fn = this.debouncedUploads.get(chatId);
        if (fn) {fn();}
    }

    /**
     * 上传当前聊天数据到服务端 (作为文件)
     */
    public async upload(chatId: string): Promise<boolean> {
        try {
            Logger.info(MODULE, `Starting upload for ${chatId}...`);
            const db = await getDbForChat(chatId);
            const dump = await exportChatData(db);

            // 使用数据库中的 lastModified 作为同步时间戳
            // 如果是首次上传或旧库，可能没有 lastModified，则使用当前时间并写入
            let lastModified = (await db.meta.get('lastModified'))?.value as number;

            if (!lastModified) {
                lastModified = Date.now();
                await db.meta.put({ key: 'lastModified', value: lastModified });
                // 更新 dump 中的 meta 以包含新的时间戳
                dump.meta['lastModified'] = lastModified;
            }

            const timestamp = lastModified;

            Logger.debug(MODULE, `导出中: ${dump.events.length} 事件, ${dump.entities.length} 实体`);

            const jsonString = JSON.stringify(dump);
            
            // P3 Fix: 增加超大文件预警，防止静默同步失败喵
            const sizeInMB = jsonString.length / (1024 * 1024);
            if (sizeInMB > 15) {
                Logger.warn(MODULE, `同步内容过大 (${sizeInMB.toFixed(2)} MB), 可能会导致同步缓慢或失败喵！`);
                notificationService.warning(`记忆库较大 (${sizeInMB.toFixed(2)} MB), 同步可能需要更长时间喵~`, 'Sync');
            }

            const fileName = getSyncFileName(chatId);

            // P0 Fix: 异步转码方案，防止大文件阻塞主线程
            // 使用 Blob + FileReader 转码为数据 URL，它能流式处理并释放 CPU 压力
            const base64Data = await new Promise<string>((resolve, reject) => {
                const blob = new Blob([jsonString], { type: 'application/json' });
                const reader = new FileReader();
                reader.onload = () => {
                    const result = reader.result as string;
                    // FileReader 的 result 包含 "data:application/json;base64," 前缀，需要剔除
                    const base64 = result.split(',')[1];
                    resolve(base64);
                };
                reader.onerror = () => reject(new Error('Base64 encoding failed'));
                reader.readAsDataURL(blob);
            });

            // 使用 /api/files/upload 上传 (带重试逻辑)
            let response: Response | null = null;
            for (let i = 0; i < 3; i++) {
                try {
                    response = await fetch('/api/files/upload', {
                        body: JSON.stringify({
                            name: fileName,
                            data: base64Data
                        }),
                        headers: getRequestHeaders(),
                        method: 'POST'
                    });
                    if (response.ok) {break;}
                    Logger.warn(MODULE, `Upload attempt ${i + 1} failed, retrying...`);
                } catch (error) {
                    if (i === 2) throw error;
                    await new Promise(r => setTimeout(r, 1000 * (i + 1))); // 指数退避
                }
            }

            if (!response || !response.ok) {
                const errText = await response?.text();
                throw new Error(`Upload failed after 3 attempts: ${response?.statusText} - ${errText}`);
            }

            Logger.success(MODULE, `上传完成: ${fileName}`);
            return true;
        } catch (error) {
            Logger.error(MODULE, `Upload error for ${chatId}`, error);
            return false;
        }
    }

    /**
     * 删除远程同步文件 (及本地 user/files/ 下的对应文件)
     */
    public async purge(chatId: string): Promise<void> {
        try {
            const deleteFile = (fileName: string) => fetch('/api/files/delete', {
                body: JSON.stringify({ path: fileName }),
                headers: getRequestHeaders(),
                method: 'POST'
            });
            await deleteFile(getSyncFileName(chatId));

            // 旧名称可能被多个聊天共用；只有归属可验证时才能联动删除。
            const legacyName = getLegacySyncFileName(chatId);
            const response = await fetch(this.getSyncFileUrl(legacyName));
            if (response.ok) {
                const meta = await readSyncMetadata(response);
                if (!needsLegacyConfirmation(chatId, meta, true)) {
                    await deleteFile(legacyName);
                }
            }
        } catch {
            // Ignore purge errors
        }
    }

    /**
     * 检查远程状态
     * 尝试下载文件头或整个文件来检查是否存在和更新时间
     */
    public async getRemoteStatus(chatId: string): Promise<{ exists: boolean, timestamp: number, requiresConfirmation?: boolean }> {
        try {
            const remote = await this.fetchRemoteFile(chatId);
            if (!remote) {return { exists: false, timestamp: 0 };}
            const meta = await readSyncMetadata(remote.response);
            const requiresConfirmation = needsLegacyConfirmation(chatId, meta, remote.legacy);
            const timestamp = Number(meta.lastModified) || 0;
            return { exists: true, timestamp, ...(requiresConfirmation ? { requiresConfirmation: true } : {}) };
        } catch (error) {
            Logger.warn(MODULE, `无法读取 ${chatId} 的同步状态`, error);
            return { exists: false, timestamp: 0 };
        }
    }

    /**
     * 下载并导入数据
     */
    public async download(chatId: string, confirmLegacy?: ConfirmLegacySync): Promise<string> {
        try {
            Logger.info(MODULE, `Downloading for ${chatId}...`);
            const remote = await this.fetchRemoteFile(chatId);
            if (!remote) {return 'no_data';}
            const dump = await remote.response.json() as ChatDataDump;

            if (!Array.isArray(dump.events) || !Array.isArray(dump.entities)) {
                throw new Error('Invalid file format: missing events or entities');
            }
            const meta = dump.meta || {};
            if (needsLegacyConfirmation(chatId, meta, remote.legacy)) {
                if (!confirmLegacy) {return 'legacy_unverified';}
                const confirmed = await confirmLegacy({
                    fileName: remote.fileName,
                    eventCount: dump.events.length,
                    entityCount: dump.entities.length,
                    summaryPreview: dump.events.slice(0, 2).map(event => String(event.summary || '').slice(0, 150)).join('\n'),
                });
                if (!confirmed) {return 'cancelled';}
            }

            // 恢复旧数据时补充归属，保留原时间戳及其他元数据。
            dump.meta = { ...meta, chatId };
            if (meta.scope_state) {
                dump.meta.scope_state = { ...meta.scope_state, chatId };
            }

            Logger.debug(MODULE, `接收数据: ${dump.events?.length} 事件, ${dump.entities?.length} 实体`);

            const db = await getDbForChat(chatId);
            this.importingChats.set(chatId, (this.importingChats.get(chatId) || 0) + 1);
            try {
                await importChatData(db, dump);
            } finally {
                const remaining = (this.importingChats.get(chatId) || 1) - 1;
                if (remaining > 0) {this.importingChats.set(chatId, remaining);}
                else {this.importingChats.delete(chatId);}
            }

            // ImportChatData 应该包含了从服务端来的 meta（其中包含 lastModified）
            // 因此不需要手动 patch 时间戳，数据库状态应当完全与远程一致
            // 如果远程文件是旧版本的（没有 lastModified），则再次上传时会补上

            // 验证写入
            const eventCount = await db.events.count();
            const entityCount = await db.entities.count();
            Logger.debug(MODULE, `导入验证: ${eventCount} 事件, ${entityCount} 实体`);

            // 迁移到不会碰撞的新名称，旧备份保留以便人工核对。
            if (remote.legacy) {await this.upload(chatId);}

            return 'success';
        } catch (error) {
            Logger.error(MODULE, `Download failed for ${chatId}`, error);
            return 'error';
        }
    }

    /**
     * 自动下载同步 (单向：远程 -> 本地)
     * 用于切换聊天时检查
     */
    public async autoSyncDownload(chatId: string): Promise<void> {
        const config = SettingsManager.getSettings().syncConfig;
        if (!config?.enabled || !config?.autoSync) {return;}

        const remoteStatus = await this.getRemoteStatus(chatId);
        if (!remoteStatus.exists || remoteStatus.requiresConfirmation) {return;}

        // 检查本地时间
        // 检查本地时间 (lastModified)
        const db = await getDbForChat(chatId);
        const localMeta = await db.meta.get('lastModified');
        const localTs = (localMeta?.value as number) || 0;

        // 如果远程更新
        if (remoteStatus.timestamp > localTs) {
            Logger.info(MODULE, `Found newer remote data (${remoteStatus.timestamp} > ${localTs}), downloading...`);
            const result = await this.download(chatId);
            if (result === 'success') {
                notificationService.success('已自动同步云端数据', 'Engram', { timeOut: 3000 });
            }
        } else {
            Logger.debug(MODULE, `Local data is up to date (Remote: ${remoteStatus.timestamp} <= Local: ${localTs})`);
        }
    }

    /**
     * 自动检查并同步
     * @returns 'downloaded' | 'uploaded' | 'synced' | 'error' | 'ignored'
     */
    public async autoSync(chatId: string): Promise<string> {
        const remoteStatus = await this.getRemoteStatus(chatId);

        // 1. 远程无数据 -> 忽略
        if (!remoteStatus.exists) {
            return 'ignored';
        }
        if (remoteStatus.requiresConfirmation) {return 'legacy_unverified';}

        // 2. 检查本地时间
        const db = await getDbForChat(chatId);
        const localMeta = await db.meta.get('lastModified');
        const localTs = (localMeta?.value as number) || 0;

        // 如果是本机刚上传的，忽略 (防回环)
        // 旧逻辑：通过 deviceId 检查
        // 新逻辑：通过严格时间戳检查 (remote > local)
        // 如果 remote == local，说明是已同步状态，返回 synced
        // 因此不需要特殊的 deviceId 检查

        // 3. 比较
        if (remoteStatus.timestamp > localTs) {
            Logger.info(MODULE, `Remote is newer (${remoteStatus.timestamp} > ${localTs}), downloading...`);
            const result = await this.download(chatId);
            return result === 'success' ? 'downloaded' : 'error';
        }
            // 本地更新，等待 debounce 上传
            return 'synced';
        
    }
}

export const syncService = SyncService.getInstance();
