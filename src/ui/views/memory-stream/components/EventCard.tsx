/**
 * EventCard - 事件卡片组件
 *
 * 显示单个 EventNode 的摘要信息
 * 遵循「无框流体」设计：边框高亮而非填充背景
 * 文本层级：heading(标题) → foreground(正文) → meta(元数据)
 */
import type { EventNode } from '@/data/types/graph';
import { toList, toText } from '@/data/utils/sanitize';
import { Archive, ChevronRight, Lock, LockOpen, Trash2, Zap } from 'lucide-react';
import React from 'react';

interface EventCardProps {
    event: EventNode;
    isSelected?: boolean;
    isCompact?: boolean;
    onSelect?: () => void;
    onCheck?: (checked: boolean) => void;
    checked?: boolean;
    /** 是否有未保存的修改 */
    hasChanges?: boolean;
    /** 是否处于召回激活状态 */
    isActive?: boolean;
    onToggleLock?: (isLocked: boolean) => void;
    onArchive?: (isArchived: boolean) => void;
    onDelete?: () => void;
    className?: string;
}

/**
 * 格式化重要性分数为可视化点
 */
function ScoreDots({ score }: { score: number }) {
    const filled = Math.round(score * 5);

    // 动态决定颜色层级
    const activeColor = score >= 0.8 ? 'bg-emphasis'
        : (score >= 0.5 ? 'bg-value'
            : 'bg-label');

    return (
        <div className="flex gap-0.5">
            {[0, 1, 2, 3, 4].map(i => (
                <span
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full ${i < filled ? activeColor : 'bg-muted'}`}
                />
            ))}
        </div>
    );
}

/**
 * 嵌入状态指示器
 */
function EmbeddingBadge({ isEmbedded }: { isEmbedded: boolean }) {
    if (!isEmbedded) {return null;}

    return (
        <span
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-primary/10 text-label rounded text-[10px] font-medium"
            title="已向量化"
        >
            <Zap size={10} />
            <span>已嵌入</span>
        </span>
    );
}

/**
 * 提取元数据行
 */
function MetaLine({ event }: { event: EventNode }) {
    // V1.5.2: 老数据 / 导入事件可能没有 structured_kv，裸读会让整张卡片渲染失败
    const kv = event.structured_kv ?? {} as EventNode['structured_kv'];
    // V1.5.2: role / location 可能被写成字符串，`.length > 0` 通过但 `.join` 不存在会直接崩整块视图
    const roles = toList(kv.role);
    const locStr = toList(kv.location).join(', ');
    const timeStr = toText(kv.time_anchor);

    if (!timeStr && !locStr && roles.length === 0) {return null;}

    return (
        <div className="flex flex-wrap items-center gap-1.5 text-xs truncate">
            {timeStr && (
                <span className="text-value">({timeStr})</span>
            )}
            {locStr && (
                <span className="text-value">@{locStr}</span>
            )}
            {roles.length > 0 && (
                <span className="text-emphasis">[{roles.join(', ')}]</span>
            )}
        </div>
    );
}

export const EventCard: React.FC<EventCardProps> = ({
    event,
    isSelected = false,
    isActive = false,
    isCompact = false,
    onSelect,
    onCheck,
    onToggleLock,
    onArchive,
    onDelete,
    checked = false,
    hasChanges = false,
    className = '',
}) => {
    const isLocked = event.is_locked;
    const kv = event.structured_kv ?? {} as EventNode['structured_kv'];
    // V1.5.2: 老数据可能没有 significance_score，直接 toFixed 会让整张卡片渲染失败
    const score = typeof event.significance_score === 'number' ? event.significance_score : 0;

    // 提取纯文本（去掉标题行）
    // V1.5.2: summary 可能被写成非字符串，直接 .split 会抛；kv.event 可能是对象，
    // 直接放进 JSX 会触发 "Objects are not valid as a React child"
    const summary = toText(event.summary);
    const summaryLines = summary.split('\n');
    const eventTitle = toText(kv.event) || summaryLines[0]?.replace(/:\s*$/, '') || '未知事件';
    const summaryText = summaryLines.length > 1
        ? summaryLines.slice(1).join(' ').trim()
        : summary;

    // 紧凑模式（移动端）
    if (isCompact) {
        return (
            <div
                className={`
                    flex items-center gap-3 p-3 cursor-pointer
                    border-b border-border
                    transition-colors duration-150
                    ${isSelected ? 'border-l-4 border-l-primary bg-transparent' : ''}
                    ${isActive ? 'border-l-4 border-l-value bg-value/5' : ''}
                    ${!isSelected && !isActive ? 'hover:border-border' : ''}
                    ${className}
                `}
                onClick={onSelect}
            >
                {/* 复选框 */}
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                        e.stopPropagation();
                        onCheck?.(e.target.checked);
                    }}
                    className="w-4 h-4 rounded border-border accent-primary"
                />

                {/* 主内容 */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-heading">
                            {eventTitle}
                        </span>
                        {event.is_embedded && (
                            <Zap size={10} className="text-label" />
                        )}
                        <span className={`text-xs ${score >= 0.8 ? 'text-emphasis' : (score >= 0.5 ? 'text-value' : 'text-label')}`}>
                            {score.toFixed(1)}
                        </span>
                    </div>
                    <p className="text-sm text-foreground truncate mt-1">
                        {summaryText.slice(0, 50)}...
                    </p>
                </div>

                {/* 快捷操作 (紧凑模式) */}
                <div className="flex items-center gap-1">
                    {/* 锁定按钮 */}
                    <button
                        className={`p-1.5 rounded-md transition-colors ${isLocked ? 'text-emphasis bg-emphasis/10' : 'text-meta opacity-40 hover:opacity-100 hover:bg-muted/50'}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleLock?.(!isLocked);
                        }}
                        title={isLocked ? '解锁' : '锁定以防止被精简或归档'}
                    >
                        {isLocked ? <Lock size={12} /> : <LockOpen size={12} />}
                    </button>

                    {/* 归档按钮 (紧凑模式) */}
                    <button
                        className={`p-1.5 rounded-md transition-colors ${event.is_archived ? 'text-emphasis bg-emphasis/10' : 'text-meta opacity-40 hover:opacity-100 hover:bg-muted/50'}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            onArchive?.(!event.is_archived); 
                        }}
                        title={event.is_archived ? '从归档中恢复' : '归档该事件'}
                    >
                        <Archive size={12} className={event.is_archived ? 'fill-current' : ''} />
                    </button>
                    
                    {/* 箭头 */}
                    <ChevronRight size={16} className="text-meta" />
                </div>
            </div>
        );
    }

    // 桌面模式 - 边框高亮而非填充背景
    return (
        <div
            className={`
                group p-4 cursor-pointer rounded-lg
                transition-all duration-150 relative overflow-hidden
                ${isSelected
                    ? 'border border-primary bg-transparent shadow-sm'
                    : (isActive
                        ? 'border border-value/50 bg-value/5 hover:border-value'
                        : 'border border-transparent hover:border-border/50 hover:bg-muted/10')
                }
                ${className}
            `}
            onClick={onSelect}
        >
            {/* 这里的 Group hover 已经在父 div 加上 group 标记了 */}
            
            {/* Active Label */}
            {isActive && (
                <div className="absolute top-2 right-2 text-[10px] text-value font-medium px-1.5 py-0.5 bg-value/10 rounded">
                    Active
                </div>
            )}

            {/* 头部：复选框 + 标签 + 嵌入状态 + 分数 */}
            <div className="flex items-center gap-3 mb-2">
                <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => {
                        e.stopPropagation();
                        onCheck?.(e.target.checked);
                    }}
                    className="w-4 h-4 rounded border-border accent-primary"
                />
                <span className="text-xs font-medium text-heading">
                    {eventTitle}
                </span>
                <EmbeddingBadge isEmbedded={event.is_embedded} />
                {hasChanges && (
                    <span className="w-2 h-2 rounded-full bg-yellow-500 animate-pulse" title="有未保存的修改" />
                )}
                
                <div className="flex-1" />

                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    {/* 归档按钮 (桌面模式) */}
                    <button
                        className={`
                            p-1.5 rounded-md transition-all
                            ${event.is_archived
                                ? 'text-emphasis bg-emphasis/10 hover:bg-emphasis/20'
                                : 'text-muted-foreground hover:bg-muted/50'
                            }
                        `}
                        onClick={(e) => {
                            e.stopPropagation();
                            onArchive?.(!event.is_archived);
                        }}
                        title={event.is_archived ? '从归档中恢复' : '归档该事件，排除出摘要上下文'}
                    >
                        <Archive size={14} className={event.is_archived ? 'fill-current' : ''} />
                    </button>

                    {/* 锁定按钮 (桌面模式) */}
                    <button
                        className={`
                            p-1.5 rounded-md transition-all
                            ${isLocked
                                ? 'text-emphasis bg-emphasis/10 hover:bg-emphasis/20 opacity-100'
                                : 'text-muted-foreground hover:bg-muted/50'
                            }
                        `}
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleLock?.(!isLocked);
                        }}
                        title={isLocked ? '点击解锁' : '锁定记忆，防止被精简或清理'}
                    >
                        {isLocked ? <Lock size={14} /> : <LockOpen size={14} />}
                    </button>

                    {/* 删除按钮 (桌面模式) - 保持谨慎颜色 */}
                    <button
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-all"
                        onClick={(e) => {
                            e.stopPropagation();
                            if (confirm('确定删除此事件吗？')) {
                                onDelete?.();
                            }
                        }}
                        title="删除事件"
                    >
                        <Trash2 size={14} />
                    </button>
                </div>

                <div className="w-px h-3 bg-border mx-1 opacity-20" />
                
                <ScoreDots score={score} />
            </div>

            {/* 元数据行 */}
            <MetaLine event={event} />

            {/* 摘要文本 */}
            <p className="text-sm text-foreground mt-1 line-clamp-2">
                {summaryText}
            </p>

            {/* 底部信息 */}
            <div className="flex items-center gap-2 mt-2 text-xs text-meta">
                <span>Level <span className="text-value font-medium">{event.level}</span></span>
                {event.source_range && (
                    <>
                        <span>•</span>
                        <span>来源: <span className="text-value">{event.source_range.start_index}-{event.source_range.end_index}楼</span></span>
                    </>
                )}
            </div>
        </div>
    );
};
