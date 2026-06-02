// ==UserScript==
// @name         YouTube 统计信息增强版
// @namespace    https://tampermonkey.net/
// @version      2.10.0
// @description  增强 YouTube Stats for nerds：优化拖动性能、后台暂停兜底刷新，并保留简约三行统计、动态颜色和油猴常开切换
// @author       longqiuyu
// @match        https://www.youtube.com/watch*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
    'use strict';

    const STORAGE_KEYS = {
        statsPanelMode: 'statsPanelMode'
    };

    const STATS_PANEL_MODES = {
        always: 'always',
        off: 'off'
    };

    function getStoredValue(key, defaultValue) {
        try {
            if (typeof GM_getValue === 'function') {
                return GM_getValue(key, defaultValue);
            }
        } catch (error) {
            // 忽略油猴存储异常，回退默认值。
        }
        return defaultValue;
    }

    function setStoredValue(key, value) {
        try {
            if (typeof GM_setValue === 'function') {
                GM_setValue(key, value);
            }
        } catch (error) {
            // 忽略油猴存储异常；本次页面刷新前仍可按当前内存值工作。
        }
    }

    let statsPanelMode = getStoredValue(STORAGE_KEYS.statsPanelMode, STATS_PANEL_MODES.off);
    if (!Object.values(STATS_PANEL_MODES).includes(statsPanelMode)) {
        statsPanelMode = STATS_PANEL_MODES.off;
    }

    const CONFIG = {
        speedDecimals: 2,
        sizeDecimals: 2,
        keepOriginal: true,
        speedBase: 1000,
        sizeBase: 1024,
        colors: {
            good: '#3EA6FF',
            warn: '#FBC02D',
            bad: '#FF4E45',
            info: '#A7A7A7',
            activity: '#B388FF'
        },
        styleId: 'yt-stats-enhancer-style',
        dragStorageKey: 'yt-stats-enhancer-floating-position',
        floatingMargin: 8,

        autoOpenDelayMs: 800,
        autoOpenAttemptLimit: 3,
        statsMenuLabels: ['Stats for nerds', '详细统计信息', '详细统计资料']
    };

    const PANEL_SELECTOR = '.html5-video-info-panel-content.ytp-sfn-content';
    const CUSTOM_PANEL_ID = 'ytse-custom-stats-panel';
    const TARGET_LABELS = new Set(['Connection Speed', 'Network Activity', 'Buffer Health']);


    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }

    function getFloatingHost(panel) {
        if (!panel) return null;
        if (panel.id === CUSTOM_PANEL_ID) return panel;
        if (panel.parentElement?.classList.contains('ytse-floating-host')) return panel.parentElement;
        return panel.closest('.html5-video-info-panel') || panel.closest('.ytp-sfn') || panel;
    }

    function readSavedFloatingPosition() {
        try {
            const raw = localStorage.getItem(CONFIG.dragStorageKey);
            if (!raw) return null;

            const parsed = JSON.parse(raw);
            if (!Number.isFinite(parsed.left) || !Number.isFinite(parsed.top)) return null;
            return parsed;
        } catch (error) {
            return null;
        }
    }

    function saveFloatingPosition(left, top) {
        try {
            localStorage.setItem(CONFIG.dragStorageKey, JSON.stringify({ left, top }));
        } catch (error) {
            // localStorage 可能被浏览器策略禁用；拖动功能本身不依赖持久化。
        }
    }

    function getInitialFloatingPosition(host) {
        const saved = readSavedFloatingPosition();
        if (saved) return saved;

        const rect = host.getBoundingClientRect();
        const left = Number.isFinite(rect.left) && rect.width
            ? rect.left
            : window.innerWidth - 460;
        const top = Number.isFinite(rect.top) && rect.height
            ? rect.top
            : 80;

        return { left, top };
    }

    function applyFloatingPosition(host, left, top) {
        const rect = host.getBoundingClientRect();
        const width = rect.width || 420;
        const height = rect.height || 220;
        const margin = CONFIG.floatingMargin;
        const maxLeft = Math.max(margin, window.innerWidth - width - margin);
        const maxTop = Math.max(margin, window.innerHeight - height - margin);
        const nextLeft = clamp(left, margin, maxLeft);
        const nextTop = clamp(top, margin, maxTop);

        host.style.setProperty('left', `${nextLeft}px`, 'important');
        host.style.setProperty('top', `${nextTop}px`, 'important');
        host.style.setProperty('right', 'auto', 'important');
        host.style.setProperty('bottom', 'auto', 'important');
        host.style.setProperty('transform', 'none', 'important');
        return { left: nextLeft, top: nextTop };
    }

    function promotePanelToFloatingLayer(host) {
        if (!host || !document.body) return;

        if (host.parentElement !== document.body) {
            document.body.appendChild(host);
        }

        host.style.setProperty('position', 'fixed', 'important');
        host.style.setProperty('z-index', '2147483647', 'important');
        host.style.setProperty('max-width', 'calc(100vw - 16px)', 'important');
        host.style.setProperty('max-height', 'calc(100vh - 16px)', 'important');
        host.style.setProperty('overflow', 'auto', 'important');
        host.style.setProperty('cursor', 'move', 'important');
        host.style.setProperty('touch-action', 'none', 'important');
        host.dataset.ytStatsFloatingPanel = '1';
        host.classList.add('ytse-floating-host');
    }

    function setupFloatingDrag(panel) {
        const host = getFloatingHost(panel);
        if (!host) return;

        promotePanelToFloatingLayer(host);

        if (!host.dataset.ytStatsFloatingPositioned) {
            const initialPosition = getInitialFloatingPosition(host);
            applyFloatingPosition(host, initialPosition.left, initialPosition.top);
            host.dataset.ytStatsFloatingPositioned = '1';
        }

        if (host.dataset.ytStatsFloatingDragReady) return;
        host.dataset.ytStatsFloatingDragReady = '1';

        let dragState = null;
        let dragFrame = 0;
        let pendingClientX = 0;
        let pendingClientY = 0;

        const applyPendingDrag = () => {
            dragFrame = 0;
            if (!dragState) return;

            const next = applyFloatingPosition(
                host,
                dragState.startLeft + pendingClientX - dragState.startX,
                dragState.startTop + pendingClientY - dragState.startY
            );
            dragState.lastLeft = next.left;
            dragState.lastTop = next.top;
        };

        const onPointerMove = (event) => {
            if (!dragState) return;

            pendingClientX = event.clientX;
            pendingClientY = event.clientY;
            if (!dragFrame) {
                dragFrame = requestAnimationFrame(applyPendingDrag);
            }
        };

        const stopDrag = () => {
            if (!dragState) return;

            if (dragFrame) {
                cancelAnimationFrame(dragFrame);
                applyPendingDrag();
            }
            saveFloatingPosition(dragState.lastLeft, dragState.lastTop);
            dragState = null;
            document.removeEventListener('pointermove', onPointerMove, true);
            document.removeEventListener('pointerup', stopDrag, true);
            document.removeEventListener('pointercancel', stopDrag, true);
            host.style.removeProperty('user-select');
        };

        host.addEventListener('pointerdown', (event) => {
            if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
            if (event.target instanceof HTMLElement && event.target.closest('a, button, input, textarea, select')) return;

            const rect = host.getBoundingClientRect();
            dragState = {
                startX: event.clientX,
                startY: event.clientY,
                startLeft: rect.left,
                startTop: rect.top,
                lastLeft: rect.left,
                lastTop: rect.top
            };
            pendingClientX = event.clientX;
            pendingClientY = event.clientY;

            host.style.setProperty('user-select', 'none', 'important');
            try { host.setPointerCapture?.(event.pointerId); } catch (error) {}
            document.addEventListener('pointermove', onPointerMove, true);
            document.addEventListener('pointerup', stopDrag, true);
            document.addEventListener('pointercancel', stopDrag, true);
            event.preventDefault();
            event.stopPropagation();
        }, true);

        window.addEventListener('resize', () => {
            const rect = host.getBoundingClientRect();
            const next = applyFloatingPosition(host, rect.left, rect.top);
            saveFloatingPosition(next.left, next.top);
        });
    }


    function ensureDisplayStyle() {
        if (document.getElementById(CONFIG.styleId)) return;

        const style = document.createElement('style');
        style.id = CONFIG.styleId;
        style.textContent = `
            .ytse-floating-host {
                min-width: 220px !important;
                width: max-content !important;
                max-width: min(390px, calc(100vw - 16px)) !important;
                color: #f1f1f1 !important;
                background: rgba(20, 20, 20, 0.92) !important;
                border: 1px solid rgba(255, 255, 255, 0.10) !important;
                border-radius: 9px !important;
                box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28) !important;
                backdrop-filter: blur(6px) !important;
                -webkit-backdrop-filter: blur(6px) !important;
                overflow: hidden !important;
                font-family: Roboto, Arial, sans-serif !important;
            }
            .ytse-floating-host * { box-sizing: border-box !important; }
            .ytse-drag-header {
                display: flex !important;
                align-items: center !important;
                justify-content: flex-start !important;
                gap: 6px !important;
                min-height: 26px !important;
                padding: 5px 34px 4px 8px !important;
                color: #f1f1f1 !important;
                background: rgba(255, 255, 255, 0.045) !important;
                border-bottom: 1px solid rgba(255, 255, 255, 0.07) !important;
                cursor: move !important;
                user-select: none !important;
            }
            .ytse-title {
                display: inline-flex !important;
                align-items: center !important;
                gap: 6px !important;
                font-size: 11px !important;
                font-weight: 600 !important;
                letter-spacing: 0 !important;
                white-space: nowrap !important;
            }
            .ytse-title::before {
                content: '' !important;
                width: 5px !important;
                height: 5px !important;
                border-radius: 999px !important;
                background: #ff0033 !important;
                opacity: 0.85 !important;
            }
            .ytse-subtitle {
                color: #9f9f9f !important;
                font-size: 10px !important;
                font-weight: 400 !important;
                white-space: nowrap !important;
                margin-left: auto !important;
            }
            .ytse-toggle {
                appearance: none !important;
                border: 0 !important;
                border-radius: 5px !important;
                background: rgba(255, 255, 255, 0.08) !important;
                color: #ddd !important;
                cursor: pointer !important;
                font-size: 10px !important;
                line-height: 1 !important;
                padding: 4px 6px !important;
                margin-left: 4px !important;
                flex: 0 0 auto !important;
            }
            .ytse-toggle:hover { background: rgba(255, 255, 255, 0.14) !important; color: #fff !important; }
            .ytse-summary {
                display: block !important;
                min-width: 310px !important;
                padding: 5px 7px 6px !important;
                font-size: 11px !important;
                line-height: 1.25 !important;
            }
            .ytse-summary-row {
                display: grid !important;
                grid-template-columns: 112px minmax(150px, 1fr) !important;
                align-items: center !important;
                column-gap: 8px !important;
                min-height: 20px !important;
                padding: 1px 2px !important;
            }
            .ytse-summary-label {
                color: #aaa !important;
                font-weight: 500 !important;
                white-space: nowrap !important;
            }
            .ytse-summary-value {
                color: #f1f1f1 !important;
                font-weight: 600 !important;
                text-align: right !important;
                white-space: nowrap !important;
                font-variant-numeric: tabular-nums !important;
            }
            .ytse-panel {
                width: 100% !important;
                padding: 5px 7px 7px !important;
                color: #e7e7e7 !important;
                background: transparent !important;
                font-size: 11px !important;
                line-height: 1.4 !important;
            }
            .ytse-panel > * {
                display: grid !important;
                grid-template-columns: 120px minmax(0, 1fr) !important;
                align-items: center !important;
                column-gap: 8px !important;
                min-height: 22px !important;
                margin: 0 !important;
                padding: 3px 5px !important;
                border-radius: 5px !important;
                border-bottom: 0 !important;
            }
            .ytse-panel > *:nth-child(odd) { background: rgba(255, 255, 255, 0.032) !important; }
            .ytse-panel > *:hover { background: rgba(255, 255, 255, 0.065) !important; }
            .ytse-label { color: #aaa !important; font-weight: 500 !important; white-space: nowrap !important; width: 120px !important; min-width: 120px !important; }
            .ytse-value {
                justify-self: end !important;
                max-width: 100% !important;
                overflow-wrap: anywhere !important;
                word-break: break-word !important;
                white-space: normal !important;
                text-align: right !important;
                font-variant-numeric: tabular-nums !important;
            }
            .ytse-enhanced-value {
                display: inline-block !important;
                padding: 0 !important;
                color: var(--ytse-value-color, #f1f1f1) !important;
                background: transparent !important;
                border: 0 !important;
                border-radius: 0 !important;
                font-weight: 600 !important;
                text-shadow: none !important;
            }
            .ytse-muted-value { color: #aaa !important; font-weight: 500 !important; }
            .ytse-floating-host[data-ytse-expanded="0"] .ytse-panel { display: none !important; }
            .ytse-floating-host[data-ytse-expanded="1"] .ytse-summary { border-bottom: 1px solid rgba(255, 255, 255, 0.07) !important; }
        `;
        document.head.appendChild(style);
    }

    function setHostExpanded(host, expanded) {
        if (!host) return;
        host.dataset.ytseExpanded = expanded ? '1' : '0';
        const button = host.querySelector(':scope > .ytse-drag-header .ytse-toggle');
        if (button) button.textContent = expanded ? '收起' : '展开';
    }

    function toggleHostExpanded(host) {
        setHostExpanded(host, host?.dataset.ytseExpanded !== '1');
    }

    function createDragHeader(subtitleText = '简约') {
        const header = document.createElement('div');
        header.className = 'ytse-drag-header';

        const title = document.createElement('span');
        title.className = 'ytse-title';
        title.textContent = 'YT Stats';

        const subtitle = document.createElement('span');
        subtitle.className = 'ytse-subtitle';
        subtitle.textContent = subtitleText;

        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ytse-toggle';
        toggle.textContent = '展开';
        toggle.addEventListener('pointerdown', (event) => event.stopPropagation(), true);
        toggle.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            toggleHostExpanded(header.parentElement);
        }, true);

        header.append(title, toggle, subtitle);
        return header;
    }

    function ensureDragHeader(host, subtitleText = '简约') {
        if (!host || host.querySelector(':scope > .ytse-drag-header')) return;
        host.insertBefore(createDragHeader(subtitleText), host.firstChild);
    }

    function ensureSummary(host) {
        if (!host) return null;
        let summary = host.querySelector(':scope > .ytse-summary');
        if (summary) return summary;

        summary = document.createElement('div');
        summary.className = 'ytse-summary';

        [
            ['speed', 'Connection Speed'],
            ['activity', 'Network Activity'],
            ['buffer', 'Buffer Health']
        ].forEach(([key, labelText]) => {
            const row = document.createElement('div');
            row.className = 'ytse-summary-row';
            row.dataset.ytseSummary = key;

            const label = document.createElement('span');
            label.className = 'ytse-summary-label';
            label.textContent = labelText;

            const value = document.createElement('span');
            value.className = 'ytse-summary-value';
            value.textContent = '--';

            row.append(label, value);
            summary.appendChild(row);
        });

        const header = host.querySelector(':scope > .ytse-drag-header');
        if (header?.nextSibling) {
            host.insertBefore(summary, header.nextSibling);
        } else {
            host.appendChild(summary);
        }
        return summary;
    }

    function updateSummaryLine(host, key, value, color = CONFIG.colors.info) {
        const summary = ensureSummary(host);
        if (!summary) return;
        const row = summary.querySelector(`[data-ytse-summary="${key}"]`);
        const valueEl = row?.querySelector('.ytse-summary-value');
        if (!valueEl) return;
        if (valueEl.textContent !== value) valueEl.textContent = value;
        valueEl.style.setProperty('color', color || CONFIG.colors.info, 'important');
    }

    function updateSummaryLines(host, lines) {
        if (!host || !lines) return;
        updateSummaryLine(host, 'speed', lines.speed || '--', lines.speedColor || CONFIG.colors.info);
        updateSummaryLine(host, 'activity', lines.activity || '--', lines.activityColor || CONFIG.colors.info);
        updateSummaryLine(host, 'buffer', lines.buffer || '--', lines.bufferColor || CONFIG.colors.info);
    }

    function updateSummary(host, mainText, subText = '', color = CONFIG.colors.info) {
        updateSummaryLines(host, {
            speed: mainText || '--',
            activity: subText || '--',
            buffer: '--',
            speedColor: color,
            activityColor: CONFIG.colors.info,
            bufferColor: CONFIG.colors.info
        });
    }

    function applyPanelDisplayStyle(panel) {
        const host = getFloatingHost(panel);
        if (!panel || !host) return;

        ensureDisplayStyle();
        host.classList.add('ytse-floating-host');
        if (!host.dataset.ytseExpanded) setHostExpanded(host, false);
        panel.classList.add('ytse-panel');
        ensureDragHeader(host);
        ensureSummary(host);
    }

    function createCustomStatRow(labelText, key) {
        const row = document.createElement('div');

        const label = document.createElement('span');
        label.className = 'ytse-label';
        label.textContent = labelText;

        const value = document.createElement('span');
        value.className = 'ytse-value ytse-enhanced-value';
        value.dataset.ytseCustom = key;

        row.append(label, value);
        return row;
    }

    function normalizeText(text) {
        return (text || '').replace(/\s+/g, ' ').trim();
    }

    function isStatsPanelOpen() {
        const panel = document.querySelector(PANEL_SELECTOR);
        return Boolean(panel && panel.isConnected);
    }

    function findVideoTarget() {
        return document.querySelector('#movie_player video')
            || document.querySelector('.html5-video-player video')
            || document.querySelector('video')
            || document.querySelector('#movie_player')
            || document.querySelector('.html5-video-player');
    }

    function findStatsMenuItem() {
        const labels = CONFIG.statsMenuLabels.map(normalizeText).filter(Boolean);
        const menuItems = Array.from(document.querySelectorAll('.ytp-menuitem'));

        return menuItems.find((item) => {
            const labelEl = item.querySelector('.ytp-menuitem-label') || item;
            const text = normalizeText(labelEl.textContent);
            return labels.some((label) => text === label || text.includes(label));
        }) || null;
    }

    function openPlayerContextMenu(target) {
        const rect = target.getBoundingClientRect();
        const x = Math.max(1, rect.left + Math.min(rect.width / 2, 120));
        const y = Math.max(1, rect.top + Math.min(rect.height / 2, 80));

        try {
            // 不传 view：Tampermonkey 沙盒里的 window 可能不是页面原生 Window，
            // YouTube/Chrome 会报 “Failed to convert value to Window”。
            target.dispatchEvent(new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                button: 2,
                buttons: 2,
                clientX: x,
                clientY: y
            }));
        } catch (error) {
            // 自动打开原生 Stats for nerds 只是辅助能力；失败时保持脚本自带常开浮窗可用。
        }
    }

    let autoOpenAttempts = 0;
    let autoOpenTimer = null;

    function clearAutoOpenTimer() {
        if (!autoOpenTimer) return;
        clearTimeout(autoOpenTimer);
        autoOpenTimer = null;
    }

    function isAutoOpenEnabled() {
        return statsPanelMode === STATS_PANEL_MODES.always;
    }

    function setStatsPanelMode(nextMode) {
        if (!Object.values(STATS_PANEL_MODES).includes(nextMode)) return;

        statsPanelMode = nextMode;
        setStoredValue(STORAGE_KEYS.statsPanelMode, nextMode);

        if (isAutoOpenEnabled()) {
            autoOpenAttempts = 0;
            startCustomStatsPanel();
            scheduleAutoOpenStatsPanel();
        } else {
            clearAutoOpenTimer();
            removeCustomStatsPanel();
        }
    }

    function registerMenuCommands() {
        if (typeof GM_registerMenuCommand !== 'function') return;

        GM_registerMenuCommand(`统计信息常开：${isAutoOpenEnabled() ? '开启' : '关闭'}（点击切换）`, () => {
            setStatsPanelMode(isAutoOpenEnabled() ? STATS_PANEL_MODES.off : STATS_PANEL_MODES.always);
            alert(`YouTube 统计信息常开已${isAutoOpenEnabled() ? '开启' : '关闭'}。
刷新页面后油猴菜单文字会同步更新。`);
        });
    }

    function attemptAutoOpenStatsPanel() {
        autoOpenTimer = null;

        if (!isAutoOpenEnabled() || isStatsPanelOpen()) return;
        if (autoOpenAttempts >= CONFIG.autoOpenAttemptLimit) return;

        const target = findVideoTarget();
        if (!target || !target.isConnected) {
            autoOpenAttempts += 1;
            scheduleAutoOpenStatsPanel();
            return;
        }

        autoOpenAttempts += 1;
        openPlayerContextMenu(target);

        setTimeout(() => {
            if (isStatsPanelOpen()) return;

            const menuItem = findStatsMenuItem();
            if (menuItem) {
                menuItem.click();
                schedulePanelScan();
                return;
            }

            scheduleAutoOpenStatsPanel();
        }, 120);
    }

    function scheduleAutoOpenStatsPanel() {
        if (!isAutoOpenEnabled() || autoOpenTimer || isStatsPanelOpen()) return;
        if (autoOpenAttempts >= CONFIG.autoOpenAttemptLimit) return;

        autoOpenTimer = setTimeout(attemptAutoOpenStatsPanel, CONFIG.autoOpenDelayMs);
    }

    let customPanelTimer = null;

    function getVideoBufferSeconds(video) {
        if (!video || !Number.isFinite(video.currentTime)) return null;

        for (let i = 0; i < video.buffered.length; i += 1) {
            const start = video.buffered.start(i);
            const end = video.buffered.end(i);
            if (video.currentTime >= start && video.currentTime <= end) {
                return Math.max(0, end - video.currentTime);
            }
        }
        return null;
    }

    function getApproxConnectionText() {
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        if (connection && Number.isFinite(connection.downlink)) {
            const kbps = connection.downlink * 1000;
            return formatSpeedSummary(kbps);
        }
        return '等待原生统计';
    }

    function getSpeedTextColor(speedText) {
        const match = normalizeText(speedText).match(/([\d.]+)\s*Mb\/s/i);
        if (!match) return CONFIG.colors.info;
        const mbps = parseFloat(match[1]);
        if (!Number.isFinite(mbps)) return CONFIG.colors.info;
        return getSpeedMeta(mbps * 1000).color;
    }

    function getPlaybackStateText(video) {
        if (!video) return '等待视频加载';
        if (video.readyState < 2) return '加载中';
        if (video.paused) return '已暂停';
        if (video.ended) return '已结束';
        if (video.seeking) return '跳转中';
        return '播放中';
    }

    function formatTime(seconds) {
        if (!Number.isFinite(seconds)) return '--:--';
        const total = Math.max(0, Math.floor(seconds));
        const min = Math.floor(total / 60);
        const sec = String(total % 60).padStart(2, '0');
        return `${min}:${sec}`;
    }

    function ensureCustomStatsPanel() {
        let panel = document.getElementById(CUSTOM_PANEL_ID);
        if (panel) return panel;

        panel = document.createElement('div');
        panel.id = CUSTOM_PANEL_ID;
        panel.dataset.ytseCustomPanel = '1';
        panel.className = 'ytse-floating-host';

        const body = document.createElement('div');
        body.className = 'ytse-panel';
        body.append(
            createCustomStatRow('连接速度', 'speed'),
            createCustomStatRow('缓冲余量', 'buffer'),
            createCustomStatRow('播放进度', 'progress'),
            createCustomStatRow('播放状态', 'state')
        );

        panel.append(createDragHeader('简约 / 可拖动'), body);
        ensureSummary(panel);
        setHostExpanded(panel, false);
        document.body.appendChild(panel);
        ensureDisplayStyle();
        promotePanelToFloatingLayer(panel);
        setupFloatingDrag(panel);
        return panel;
    }

    function setCustomValue(panel, key, text, color) {
        const el = panel.querySelector(`[data-ytse-custom="${key}"]`);
        if (!el) return;
        if (el.textContent !== text) el.textContent = text;
        el.style.setProperty('--ytse-value-color', color || CONFIG.colors.info);
        el.style.color = color || CONFIG.colors.info;
        el.classList.toggle('ytse-muted-value', (color || CONFIG.colors.info) === CONFIG.colors.info);
    }

    function updateCustomStatsPanel() {
        if (document.hidden) return;

        if (!isAutoOpenEnabled() || isStatsPanelOpen()) {
            removeCustomStatsPanel();
            return;
        }

        const panel = ensureCustomStatsPanel();
        const video = document.querySelector('#movie_player video')
            || document.querySelector('.html5-video-player video')
            || document.querySelector('video');

        const speedText = getApproxConnectionText();
        setCustomValue(panel, 'speed', speedText, getSpeedTextColor(speedText));
        setCustomValue(panel, 'state', getPlaybackStateText(video), video && !video.paused ? CONFIG.colors.good : CONFIG.colors.info);
        setCustomValue(panel, 'progress', video && Number.isFinite(video.currentTime)
            ? `${formatTime(video.currentTime)} / ${Number.isFinite(video.duration) ? formatTime(video.duration) : '--:--'}`
            : '--:-- / --:--', CONFIG.colors.info);

        const bufferSeconds = getVideoBufferSeconds(video);
        if (bufferSeconds === null) {
            setCustomValue(panel, 'buffer', '等待缓冲数据', CONFIG.colors.warn);
            updateSummaryLines(panel, {
                speed: speedText,
                activity: '等待原生统计',
                buffer: '等待缓冲数据',
                speedColor: getSpeedTextColor(speedText),
                activityColor: CONFIG.colors.info,
                bufferColor: CONFIG.colors.warn
            });
        } else {
            const meta = getBufferHealthMeta(bufferSeconds);
            setCustomValue(panel, 'buffer', `${bufferSeconds.toFixed(2)} s (${meta.label})`, meta.color);
            updateSummaryLines(panel, {
                speed: speedText,
                activity: '等待原生统计',
                buffer: `${bufferSeconds.toFixed(2)} s (${meta.label})`,
                speedColor: getSpeedTextColor(speedText),
                activityColor: CONFIG.colors.info,
                bufferColor: meta.color
            });
        }
    }

    function startCustomStatsPanel() {
        if (document.hidden || !isAutoOpenEnabled() || isStatsPanelOpen()) return;
        updateCustomStatsPanel();
        if (!customPanelTimer) {
            customPanelTimer = setInterval(updateCustomStatsPanel, 1000);
        }
    }

    function removeCustomStatsPanel() {
        const panel = document.getElementById(CUSTOM_PANEL_ID);
        if (panel) panel.remove();
        if (customPanelTimer) {
            clearInterval(customPanelTimer);
            customPanelTimer = null;
        }
    }

    function getRowValueLeafSpan(row) {
        if (!row) return null;

        const spans = Array.from(row.querySelectorAll('span'));
        const candidates = spans.filter((span) => {
            const text = normalizeText(span.textContent);
            return span.children.length === 0 && text;
        });

        return candidates.length ? candidates[candidates.length - 1] : null;
    }

    function extractNumber(text, unitPattern) {
        const normalized = normalizeText(text);
        if (!normalized) return null;

        const regex = new RegExp(`([\\d.]+)\\s*${unitPattern}`, 'i');
        const match = normalized.match(regex);
        if (!match) return null;

        const value = parseFloat(match[1]);
        return Number.isFinite(value) ? value : null;
    }

    function formatSpeed(kbps) {
        const mbps = kbps / CONFIG.speedBase;
        const mBps = kbps / 8 / CONFIG.speedBase;

        if (CONFIG.keepOriginal) {
            return `${mbps.toFixed(CONFIG.speedDecimals)} Mb/s (${Math.round(kbps)} kbps, ${mBps.toFixed(CONFIG.speedDecimals)} MB/s)`;
        }

        return `${mbps.toFixed(CONFIG.speedDecimals)} Mb/s (${mBps.toFixed(CONFIG.speedDecimals)} MB/s)`;
    }

    function formatSpeedSummary(kbps) {
        const mbps = kbps / CONFIG.speedBase;
        return `${mbps.toFixed(CONFIG.speedDecimals)} Mb/s · ${Math.round(kbps)} kbps`;
    }

    function formatSize(kb) {
        const mb = kb / CONFIG.sizeBase;

        if (CONFIG.keepOriginal) {
            return `${mb.toFixed(CONFIG.sizeDecimals)} MB (${Math.round(kb)} KB)`;
        }

        return `${mb.toFixed(CONFIG.sizeDecimals)} MB`;
    }

    function getSourceText(span) {
        if (!span) return '';

        const currentText = normalizeText(span.textContent);
        const renderedText = normalizeText(span.dataset.ytStatsEnhancedValue || '');
        const sourceText = normalizeText(span.dataset.ytStatsSourceValue || '');

        if (sourceText && renderedText && currentText === renderedText) {
            return sourceText;
        }

        return currentText;
    }

    function getSpeedMeta(kbps) {
        if (kbps < 3000) {
            return { label: '偏低', color: CONFIG.colors.bad };
        }
        if (kbps < 10000) {
            return { label: '一般', color: CONFIG.colors.warn };
        }
        return { label: '良好', color: CONFIG.colors.good };
    }

    function getActivityColor(kb) {
        if (kb <= 0) return CONFIG.colors.info;
        return CONFIG.colors.activity;
    }

    function getBufferHealthMeta(seconds) {
        if (seconds < 3) {
            return { label: '偏低', color: CONFIG.colors.bad };
        }
        if (seconds < 8) {
            return { label: '一般', color: CONFIG.colors.warn };
        }
        return { label: '良好', color: CONFIG.colors.good };
    }

    function markEnhanced(span, renderedText, color, sourceText) {
        if (!span) return;
        if (span.dataset.ytStatsEnhancedValue === renderedText && (!color || span.dataset.ytStatsEnhancedColor === color)) {
            return;
        }

        span.dataset.ytStatsEnhancedValue = renderedText;
        span.dataset.ytStatsEnhancedColor = color || '';
        span.dataset.ytStatsSourceValue = normalizeText(sourceText || span.textContent);
        span.textContent = renderedText;
        span.classList.add('ytse-value', 'ytse-enhanced-value');
        span.style.setProperty('--ytse-value-color', color || CONFIG.colors.good);
        span.style.color = color || CONFIG.colors.good;
        span.style.fontWeight = '750';
    }

    function enhancePanel(panel) {
        if (!panel || !panel.isConnected) return;

        applyPanelDisplayStyle(panel);

        const rows = Array.from(panel.children).filter((node) => node instanceof HTMLElement);
        const summary = { speed: '', activity: '', buffer: '', speedColor: CONFIG.colors.good, activityColor: CONFIG.colors.info, bufferColor: CONFIG.colors.info };

        rows.forEach((row) => {
            const labelEl = row.firstElementChild;
            labelEl?.classList.add('ytse-label');
            const label = normalizeText(labelEl ? labelEl.textContent : '');
            if (!TARGET_LABELS.has(label)) return;

            const valueSpan = getRowValueLeafSpan(row);
            if (!label || !valueSpan) return;

            const valueText = getSourceText(valueSpan);
            if (!valueText) return;

            if (label === 'Connection Speed') {
                const kbps = extractNumber(valueText, 'Kbps');
                if (kbps !== null) {
                    const rendered = formatSpeed(kbps);
                    const meta = getSpeedMeta(kbps);
                    summary.speed = rendered;
                    summary.speedColor = meta.color;
                    markEnhanced(valueSpan, rendered, meta.color, valueText);
                }
                return;
            }

            if (label === 'Network Activity') {
                const kb = extractNumber(valueText, 'KB');
                if (kb !== null) {
                    const rendered = formatSize(kb);
                    const activityColor = getActivityColor(kb);
                    summary.activity = rendered;
                    summary.activityColor = activityColor;
                    markEnhanced(valueSpan, rendered, activityColor, valueText);
                }
                return;
            }

            if (label === 'Buffer Health') {
                const seconds = extractNumber(valueText, 's');
                if (seconds !== null) {
                    const meta = getBufferHealthMeta(seconds);
                    const rendered = `${seconds.toFixed(2)} s (${meta.label})`;
                    summary.buffer = rendered;
                    summary.bufferColor = meta.color;
                    markEnhanced(valueSpan, rendered, meta.color, valueText);
                }
                return;
            }

        });

        const host = getFloatingHost(panel);
        if (summary.speed || summary.activity || summary.buffer) {
            updateSummaryLines(host, summary);
        }
    }

    let currentPanel = null;
    let panelObserver = null;
    let rootObserver = null;
    let enhanceScheduled = false;
    let scanScheduled = false;
    let runInProgress = false;
    let suppressPanelObserver = false;

    function withObserverSuppressed(fn) {
        suppressPanelObserver = true;
        try {
            fn();
        } finally {
            setTimeout(() => {
                suppressPanelObserver = false;
            }, 0);
        }
    }

    function run() {
        if (!currentPanel || !currentPanel.isConnected || runInProgress) return;

        runInProgress = true;
        try {
            withObserverSuppressed(() => {
                enhancePanel(currentPanel);
            });
        } finally {
            runInProgress = false;
        }
    }

    function scheduleEnhance() {
        if (!currentPanel || enhanceScheduled) return;

        enhanceScheduled = true;
        queueMicrotask(() => {
            enhanceScheduled = false;
            run();
        });
    }

    function disconnectPanelObserver() {
        if (panelObserver) {
            panelObserver.disconnect();
            panelObserver = null;
        }
        currentPanel = null;
    }

    function bindPanel(panel) {
        if (currentPanel === panel) return;

        disconnectPanelObserver();
        if (!panel) return;

        currentPanel = panel;
        applyPanelDisplayStyle(panel);
        setupFloatingDrag(panel);
        panelObserver = new MutationObserver(() => {
            if (suppressPanelObserver) return;
            scheduleEnhance();
        });

        panelObserver.observe(panel, {
            childList: true,
            subtree: true,
            characterData: true
        });

        scheduleEnhance();
    }

    function scanPanel() {
        const panel = document.querySelector(PANEL_SELECTOR);

        if (!panel || !panel.isConnected) {
            disconnectPanelObserver();
            startCustomStatsPanel();
            scheduleAutoOpenStatsPanel();
            return;
        }

        removeCustomStatsPanel();
        clearAutoOpenTimer();
        autoOpenAttempts = 0;
        bindPanel(panel);
    }

    function schedulePanelScan() {
        if (scanScheduled) return;

        scanScheduled = true;
        requestAnimationFrame(() => {
            scanScheduled = false;
            scanPanel();
        });
    }

    function isPanelMutationNode(node) {
        if (!(node instanceof HTMLElement)) return false;
        if (node.matches(PANEL_SELECTOR)) return true;
        return Boolean(node.querySelector(PANEL_SELECTOR));
    }

    function shouldScanPanel(mutations) {
        if (currentPanel && !currentPanel.isConnected) return true;

        return mutations.some((mutation) => {
            if (isPanelMutationNode(mutation.target)) return true;

            return Array.from(mutation.addedNodes).some(isPanelMutationNode)
                || Array.from(mutation.removedNodes).some(isPanelMutationNode);
        });
    }

    function init() {
        rootObserver = new MutationObserver((mutations) => {
            if (shouldScanPanel(mutations)) {
                schedulePanelScan();
            }
        });

        if (document.body) {
            rootObserver.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        window.addEventListener('yt-navigate-finish', schedulePanelScan, true);
        window.addEventListener('yt-page-data-updated', schedulePanelScan, true);
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) {
                schedulePanelScan();
                scheduleEnhance();
            } else {
                removeCustomStatsPanel();
            }
        });

        registerMenuCommands();
        schedulePanelScan();
        startCustomStatsPanel();
        scheduleAutoOpenStatsPanel();
    }

    init();
})();
