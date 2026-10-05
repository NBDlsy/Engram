/**
 * STBridge - SillyTavern API 桥接层
 *
 * 这是唯一与 SillyTavern 直接交互的模块。
 * 所有 window.SillyTavern、jQuery、eventSource 的调用都在这里统一管理。
 */
// 使用统一的 STContext 模块
export { getSTContext, type STMessage } from "./context";
// 从专门化的 Adapter 中导出方法
export { hideMessageRange, injectMessage } from "../chat/chat";
export {
    callPopup, createTopBarButton, mountGlobalOverlay, openMainPanel, setGlobalRenderer, setReactRenderer, toggleMainPanel
} from "../ui/ui";

declare const __ENGRAM_VERSION__: string;
declare const __ENGRAM_BUILD_TIME__: string;

/**
 * 初始化 Engram 插件
 */
export async function initializeEngram(): Promise<void> {
    // 初始化日志系统
    const { Logger } = await import('@/core/logger');
    await Logger.init();

    // V1.5.2: 打印构建版本与构建时间。
    // 线上排障（例如"改了代码但线上还在报旧错"）时，先看这行就能确认浏览器加载的是哪一版 bundle。
    // typeof 兜底：vitest 不注入这两个常量。
    const buildVersion = typeof __ENGRAM_VERSION__ !== 'undefined' ? __ENGRAM_VERSION__ : 'dev';
    const buildStamp = typeof __ENGRAM_BUILD_TIME__ !== 'undefined' ? __ENGRAM_BUILD_TIME__ : 'dev';
    // V1.5.2: 同时给出本地时间。ISO 串（UTC）看着不直观，曾导致「线上跑的是 3 小时前的旧包」
    // 反复排查；本地时间一眼就能和自己的构建时刻对上。
    let buildLocal = buildStamp;
    if (buildStamp !== 'dev') {
        const d = new Date(buildStamp);
        if (!Number.isNaN(d.getTime())) {
            buildLocal = d.toLocaleString('zh-CN', { hour12: false });
        }
    }
    Logger.info('STBridge', `Engram v${buildVersion} 已加载 (构建于 ${buildLocal})`, {
        buildTime: buildStamp,
        buildLocal
    });

    Logger.info('STBridge', 'Engram 插件正在初始化...');

    // 初始化设置管理器
    const { SettingsManager } = await import('@/config/settings');
    SettingsManager.initSettings();
    Logger.info('STBridge', 'SettingsManager 初始化完成');

    // 加载保存的正则规则到全局处理器
    const savedRegexRules = SettingsManager.getRegexRules();
    if (savedRegexRules && savedRegexRules.length > 0) {
        const { regexProcessor } = await import('@/modules/workflow/steps');
        regexProcessor.setRules(savedRegexRules);
        Logger.info('STBridge', `已加载 ${savedRegexRules.length} 条正则规则`);
    }

    // 检查酒馆接口对接状态
    try {
        const { checkTavernIntegration } = await import('@/integrations/tavern/api');
        const tavernStatus = await checkTavernIntegration();
        Logger.info('TavernAPI', '酒馆接口对接状态', tavernStatus);
    } catch (error) {
        Logger.warn('TavernAPI', '酒馆接口检查失败', { error: String(error) });
    }

    // 启动 Summarizer 服务
    try {
        const { summarizerService } = await import('@/modules/memory/Summarizer');
        summarizerService.start();
        const status = summarizerService.getStatus();
        Logger.info('Summarizer', '服务已启动', status);
    } catch (error) {
        Logger.warn('Summarizer', '服务启动失败', { error: String(error) });
    }

    // Start Entity Extraction Service (V0.9.14)
    try {
        const { entityBuilder } = await import('@/modules/memory/EntityExtractor');
        entityBuilder.start();
        Logger.info('EntityBuilder', 'Service started');
    } catch (error) {
        Logger.warn('EntityBuilder', 'Service start failed', { error: String(error) });
    }

    // 从 ui 提取加载顶部按钮指令
    const { createTopBarButton } = await import('@/integrations/tavern');
    // 优先使用顶栏按钮，找不到则使用悬浮球
    createTopBarButton();


    // 初始化主题系统 (注入 CSS 并应用变量)
    const { ThemeManager } = await import('@/ui/services/ThemeManager');
    ThemeManager.init();

    // Initialize Injector Service (V0.4 - Dynamic Context)
    try {
        const { injector } = await import('@/modules/rag/injection/Injector');
        injector.init();
        Logger.info('Injector', '注入服务初始化完成');
    } catch (error) {
        Logger.warn('Injector', '注入服务初始化失败', { error: String(error) });
    }

    // Initialize MacroService (Global ST Macros) and Worldbook Slot
    try {
        const { WorldBookSlotService } = await import('@/integrations/tavern/worldbook');
        await WorldBookSlotService.init();

        const { MacroService } = await import('@/integrations/tavern');
        await MacroService.init();
    } catch (error) {
        Logger.warn('MacroService', '宏服务/世界书初始化失败', { error: String(error) });
    }

    // V0.8: Initialize QR 栏快捷按钮
    try {
        const { initQuickPanelButton } = await import('@/integrations/tavern');
        initQuickPanelButton();
        Logger.info('QuickPanelButton', 'QR 栏按钮初始化完成');
    } catch (error) {
        Logger.warn('QuickPanelButton', 'QR 栏按钮初始化失败', { error: String(error) });
    }

    // 挂载全局悬浮层 (用于修订弹窗等)
    const { mountGlobalOverlay } = await import('@/integrations/tavern');
    mountGlobalOverlay();

    // 初始化角色删除联动服务
    try {
        const { CharacterDeleteService } = await import('@/data/cleanup/CharacterCleanup');
        CharacterDeleteService.init();
        Logger.info('STBridge', '角色联动清理服务初始化完成');
    } catch (error) {
        Logger.warn('STBridge', '角色联动清理服务初始化失败', { error: String(error) });
    }

    // V0.9.5: 初始化键盘快捷键
    try {
        const { setupKeyboardShortcuts } = await import('@/core/KeyboardManager');
        const { toggleQuickPanel, openCommandPalette } = await import('@/index');
        const { toggleMainPanel } = await import('@/integrations/tavern');

        setupKeyboardShortcuts({
            toggleMainPanel,
            toggleQuickPanel,
            openCommandPalette,
        });
        Logger.info('STBridge', '键盘快捷键初始化完成');
    } catch (error) {
        Logger.warn('STBridge', '键盘快捷键初始化失败', { error: String(error) });
    }

    Logger.success('STBridge', 'Engram 初始化完成 - Where memories leave their trace.');
}

