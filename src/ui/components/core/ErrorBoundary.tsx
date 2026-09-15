import type { ErrorInfo, ReactNode } from 'react';
import { Component } from 'react';
import { Logger } from '@/core/logger';

interface Props {
    children?: ReactNode;
    fallback?: ReactNode;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    /** V1.5.2: 出错时用于定位是哪一条数据（如事件 id） */
    label?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
    public state: State = {
        error: null,
        hasError: false
    };

    public static getDerivedStateFromError(error: Error): State {
        return { error, hasError: true };
    }

    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error('[ErrorBoundary] Uncaught error:', error, errorInfo);
        // V1.5.2: 只打控制台等于没打 —— 日志面板看不到、用户也不看 F12。
        // 同步写进 Engram 开发者日志，方便直接查到是哪条数据、什么错。
        Logger.error('ErrorBoundary', `渲染失败${this.props.label ? ` (${this.props.label})` : ''}: ${error?.message ?? String(error)}`, {
            componentStack: errorInfo?.componentStack?.split('\n').slice(0, 6).join(' | '),
            label: this.props.label,
            stack: error?.stack?.split('\n').slice(0, 4).join(' | ')
        });
        if (this.props.onError) {
            this.props.onError(error, errorInfo);
        }
    }

    public render() {
        if (this.state.hasError) {
            return this.props.fallback || (
                <div
                    className="p-4 m-2 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm flex flex-col gap-1"
                    title={this.state.error?.stack || undefined}
                >
                    <span>组件加载失败，请检查数据完整性或尝试刷新。</span>
                    <span className="text-xs opacity-80 break-all">
                        {this.props.label ? `${this.props.label} · ` : ''}{this.state.error?.message || '未知错误'}
                    </span>
                </div>
            );
        }

        return this.props.children;
    }
}
