import {
    type AppSettings,
    clearBinaryCache,
    getCacheStats,
    type ResizeOption,
    type ThemeMode,
} from "@discordcon/core";
import React, { useEffect, useState } from "react";

import {
    isAutostartEnabled,
    registerOverlayShortcut,
    setAutostartEnabled,
    setBlurSuppressed,
} from "../adapters/tauriBridge";
import { checkAndAutoInstallUpdate } from "../adapters/updater";

interface SettingsModalProps {
    settings: AppSettings;
    onSaveSettings: (next: AppSettings) => Promise<void>;
    onClose: () => void;
    onNotify: (msg: string, variant?: "success" | "error" | "info") => void;
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function keyEventToShortcut(e: React.KeyboardEvent): string | null {
    const parts: string[] = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Super");

    const key = e.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) {
        return null;
    }
    if (parts.length === 0) return null;

    const normalized = key.length === 1 ? key.toUpperCase() : key;
    parts.push(normalized);
    return parts.join("+");
}

export function SettingsModal({
    settings,
    onSaveSettings,
    onClose,
    onNotify,
}: SettingsModalProps) {
    const [shortcut, setShortcut] = useState(settings.shortcut);
    const [recording, setRecording] = useState(false);
    const [resizeOption, setResizeOption] = useState<ResizeOption>(settings.resizeOption);
    const [theme, setTheme] = useState<ThemeMode>(settings.theme);
    const [autoStart, setAutoStart] = useState(settings.autoStart);
    const [cacheStats, setCacheStats] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 });
    const [saving, setSaving] = useState(false);
    const [checkingUpdate, setCheckingUpdate] = useState(false);

    useEffect(() => {
        void setBlurSuppressed(true);
        void getCacheStats().then(setCacheStats);
        void isAutostartEnabled()
            .then(setAutoStart)
            .catch(() => {});

        return () => {
            void setBlurSuppressed(false);
        };
    }, []);

    const handleSave = async () => {
        setSaving(true);
        try {
            if (shortcut !== settings.shortcut) {
                await registerOverlayShortcut(shortcut);
            }
            await setAutostartEnabled(autoStart).catch(() => {});
            await onSaveSettings({
                shortcut,
                resizeOption,
                autoStart,
                theme,
            });
            onNotify("설정이 저장되었습니다.", "success");
            onClose();
        } catch (err) {
            const message =
                err instanceof Error && err.message
                    ? err.message
                    : typeof err === "string" && err.trim().length > 0
                      ? err
                      : "설정 저장 실패";
            onNotify(message, "error");
        } finally {
            setSaving(false);
        }
    };

    const handleClearCache = async () => {
        await clearBinaryCache();
        setCacheStats({ count: 0, bytes: 0 });
        onNotify("이미지 캐시를 비웠습니다.", "success");
    };

    const handleCheckUpdate = async () => {
        setCheckingUpdate(true);
        try {
            await checkAndAutoInstallUpdate({
                silent: false,
                onStatus: (msg, variant) => onNotify(msg, variant ?? "info"),
            });
        } finally {
            setCheckingUpdate(false);
        }
    };

    return (
        <div className="dc-ke-modal-backdrop" onClick={onClose}>
            <div className="dc-ke-modal" onClick={e => e.stopPropagation()}>
                <div className="dc-ke-modal-header">
                    <h3>설정</h3>
                    <button type="button" className="dc-ke-icon-btn" onClick={onClose}>
                        ✕
                    </button>
                </div>

                <div className="dc-ke-modal-body">
                    <div className="dc-ke-field">
                        <label>오버레이 단축키</label>
                        <div className="dc-ke-shortcut-row">
                            <input
                                className="dc-ke-input"
                                type="text"
                                readOnly={recording}
                                value={recording ? "키 조합을 누르세요..." : shortcut}
                                onChange={e => setShortcut(e.target.value)}
                                onKeyDown={e => {
                                    if (!recording) return;
                                    e.preventDefault();
                                    e.stopPropagation();
                                    const combo = keyEventToShortcut(e);
                                    if (combo) {
                                        setShortcut(combo);
                                        setRecording(false);
                                    }
                                }}
                            />
                            <button
                                type="button"
                                className="dc-ke-btn secondary"
                                onClick={() => setRecording(r => !r)}
                            >
                                {recording ? "취소" : "키 녹화"}
                            </button>
                        </div>
                    </div>

                    <div className="dc-ke-field">
                        <label>기본 전송 크기</label>
                        <select
                            className="dc-ke-select"
                            value={String(resizeOption)}
                            onChange={e => setResizeOption(Number(e.target.value) as ResizeOption)}
                        >
                            <option value="120">120px (디시콘 권장)</option>
                            <option value="160">160px</option>
                            <option value="0">원본 크기</option>
                        </select>
                    </div>

                    <div className="dc-ke-field">
                        <label htmlFor="dc-theme">테마</label>
                        <select
                            id="dc-theme"
                            className="dc-ke-select"
                            value={theme}
                            onChange={e => setTheme(e.target.value as ThemeMode)}
                        >
                            <option value="system">시스템 설정 따름</option>
                            <option value="light">라이트</option>
                            <option value="dark">다크</option>
                        </select>
                    </div>

                    <div className="dc-ke-field row">
                        <label htmlFor="dc-autostart">Windows 시작 시 자동 실행</label>
                        <input
                            id="dc-autostart"
                            type="checkbox"
                            checked={autoStart}
                            onChange={e => setAutoStart(e.target.checked)}
                        />
                    </div>

                    <div className="dc-ke-field">
                        <label>로컬 캐시 (IndexedDB)</label>
                        <div className="dc-ke-cache-row">
                            <span>
                                {cacheStats.count}개 항목 · {formatBytes(cacheStats.bytes)}
                            </span>
                            <button
                                type="button"
                                className="dc-ke-btn danger"
                                onClick={() => void handleClearCache()}
                            >
                                캐시 비우기
                            </button>
                        </div>
                    </div>

                    <div className="dc-ke-field">
                        <label>앱 업데이트</label>
                        <div className="dc-ke-cache-row">
                            <span>시작 시 자동으로 최신 버전을 확인합니다.</span>
                            <button
                                type="button"
                                className="dc-ke-btn secondary"
                                disabled={checkingUpdate}
                                onClick={() => void handleCheckUpdate()}
                            >
                                {checkingUpdate ? "확인 중..." : "업데이트 확인"}
                            </button>
                        </div>
                    </div>
                </div>

                <div className="dc-ke-modal-footer">
                    <button type="button" className="dc-ke-btn secondary" onClick={onClose}>
                        닫기
                    </button>
                    <button
                        type="button"
                        className="dc-ke-btn"
                        disabled={saving}
                        onClick={() => void handleSave()}
                    >
                        {saving ? "저장 중..." : "저장"}
                    </button>
                </div>
            </div>
        </div>
    );
}
