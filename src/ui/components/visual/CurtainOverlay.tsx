import React, { memo, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';

interface CurtainOverlayProps {
    mode: 'entrance' | 'exit';
    onComplete?: () => void;
    onReveal?: () => void;
    onCovered?: () => void; // 当遮罩完全遮住屏幕时触发
    hostColor?: string; // 宿主环境背景色
    direction?: 'left' | 'top'; // V10: 极致精简 (左/下落)
}

/**
 * CurtainOverlay Component (V10 - Final Rhythm)
 * 极致收敛与呼吸感调优
 */
export const CurtainOverlay: React.FC<CurtainOverlayProps> = memo(({
    mode,
    onComplete,
    onReveal,
    onCovered,
    hostColor = '#000',
    direction = 'left'
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const layerRef = useRef<HTMLDivElement>(null);

    // V1.5.2: 回调放进 ref。此前它们直接在 deps 里，父组件每次 setState 都会换掉回调身份，
    // 导致 effect 重跑 → ctx.revert() 把正在播放的时间线掐断 → onComplete 永远不触发，
    // 界面就停在「内容已卸载 + pointer-events:none」的透明死锁状态。
    const cbsRef = useRef({ onCovered, onComplete, onReveal });
    cbsRef.current = { onCovered, onComplete, onReveal };

    useLayoutEffect(() => {
        const isHorizontal = direction === 'left';
        const axis = isHorizontal ? 'x' : 'y';

        const travelDistance = isHorizontal ? '100%' : '-100%';
        const exitDistance = isHorizontal ? '-100%' : '100%';


        const ctx = gsap.context(() => {
            const tl = gsap.timeline({
                onComplete: () => {
                    cbsRef.current.onComplete?.();
                }
            });

            const targetColor = getComputedStyle(document.documentElement).getPropertyValue('--background').trim() || '#1a1b26';

            if (mode === 'entrance') {
                gsap.set(layerRef.current, {
                    [axis]: travelDistance,
                    opacity: 0,
                    backgroundColor: hostColor
                });

                tl.to(layerRef.current, {
                    [axis]: '0%',
                    opacity: 1,
                    duration: 0.5, // 0.7 -> 0.5
                    ease: 'power2.out',
                    onComplete: () => cbsRef.current.onCovered?.()
                })
                .to(layerRef.current, {
                    backgroundColor: targetColor,
                    duration: 0.35 // 0.5 -> 0.35
                })
                .add(() => cbsRef.current.onReveal?.())
                .to(layerRef.current, {
                    [axis]: exitDistance,
                    duration: 0.55, // 0.8 -> 0.55
                    ease: 'power2.inOut'
                }, '+=0.15');

            } else {
                gsap.set(layerRef.current, { [axis]: travelDistance, opacity: 0 });

                tl.to(layerRef.current, {
                    [axis]: '0%',
                    opacity: 1,
                    backgroundColor: targetColor,
                    duration: 0.45, // 0.6 -> 0.45
                    ease: 'power2.in',
                    onComplete: () => cbsRef.current.onCovered?.()
                })
                .to(layerRef.current, {
                    backgroundColor: hostColor,
                    duration: 0.35 // 0.5 -> 0.35
                })
                .to(layerRef.current, {
                    [axis]: exitDistance,
                    duration: 0.55, // 0.8 -> 0.55
                    ease: 'power2.out'
                }, '+=0.1');
            }
        }, containerRef);

        return () => ctx.revert();
    }, [mode, direction, hostColor]);

    return (
        <div className="engram-curtain-container" ref={containerRef}>
            <div ref={layerRef} className="engram-curtain-slice bottom" style={{ height: '100%', width: '100%' }} />
        </div>
    );
});

