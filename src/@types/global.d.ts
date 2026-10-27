/**
 * 全局类型声明
 *
 * 扩展 Window 接口，为 SillyTavern 全局 API 提供类型提示
 */

// 导入 ST 类型定义
/// <reference path="./st-types/index.d.ts" />

// 本文件是全局声明文件，直接扩展 Window。
// SillyTavern 和 TavernHelper 的类型沿用 st-types/index.d.ts，避免重复声明。
interface Window {
    /** 当前选择的模型名称；宿主未提供时为 undefined。 */
    selected_model?: string;
}

// Vite ?raw 导入声明
declare module '*.md?raw' {
    const content: string;
    export default content;
}

declare module '*.txt?raw' {
    const content: string;
    export default content;
}
