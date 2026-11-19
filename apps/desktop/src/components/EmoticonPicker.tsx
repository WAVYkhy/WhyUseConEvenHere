import {
    addRecentKey,
    type AppSettings,
    DEFAULT_APP_SETTINGS,
    deleteCachedBlobsByPrefix,
    type EmoticonItem,
    type EmoticonPack,
    fetchPackMetadata,
    getOrFetchPreviewBlob,
    getOrFetchThumbnailBlob,
    parsePackInput,
    prepareEmoticonForUpload,
    refreshPack,
    type ResizeOption,
    toggleFavoriteKey,
} from "@discordcon/core";
import { listen } from "@tauri-apps/api/event";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
    copyMediaToClipboard,
    hideOverlayWindow,
    registerOverlayShortcut,
    tauriBridge,
} from "../adapters/tauriBridge";
import { tauriStorage } from "../adapters/tauriStorage";
import { checkAndAutoInstallUpdate } from "../adapters/updater";
import { AddPackPanel, PackBar } from "./PackManager";
import { SettingsModal } from "./SettingsModal";

type ActiveTab = "recent" | "favorites" | "add" | string;

interface ToastState {
    text: string;
    variant: "success" | "error" | "info";
}

function getErrorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message) return err.message;
    if (typeof err === "string" && err.trim().length > 0) return err;
    return fallback;
}

function PackTabThumb({
    pack,
    onPackUpdated,
}: {
    pack: EmoticonPack;
    onPackUpdated: (updated: EmoticonPack) => void;
}) {
    const [src, setSrc] = useState<string | null>(null);
    const firstItem = pack.items[0];

    useEffect(() => {
        if (!firstItem) return;
        let cancelled = false;
        let objectUrl: string | null = null;

        getOrFetchThumbnailBlob(tauriBridge, firstItem, pack, onPackUpdated)
            .then(blob => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setSrc(objectUrl);
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [pack.id, firstItem?.key]);

    if (src) {
        return <img className="dc-ke-tab-thumb" src={src} alt={pack.title} />;
    }
    return <span style={{ fontSize: 12, fontWeight: 700 }}>{pack.title.slice(0, 2)}</span>;
}

function EmoticonTile({
    item,
    pack,
    isFavorite,
    isBusy,
    onSelect,
    onToggleFavorite,
    onPackUpdated,
}: {
    item: EmoticonItem;
    pack: EmoticonPack;
    isFavorite: boolean;
    isBusy: boolean;
    onSelect: (item: EmoticonItem, pack: EmoticonPack) => void;
    onToggleFavorite: (key: string) => void;
    onPackUpdated: (updated: EmoticonPack) => void;
}) {
    const tileRef = useRef<HTMLDivElement | null>(null);
    const [visible, setVisible] = useState(false);
    const [hovered, setHovered] = useState(false);
    const [posterSrc, setPosterSrc] = useState<string | null>(null);
    const [previewSrc, setPreviewSrc] = useState<string | null>(null);
    const [isVideoPreview, setIsVideoPreview] = useState(false);
    const [failed, setFailed] = useState(false);
    const isAnimated = item.type === "video" || item.ext === "gif" || item.ext === "webp";

    useEffect(() => {
        const el = tileRef.current;
        if (!el) return;

        const observer = new IntersectionObserver(
            entries => {
                if (entries.some(e => e.isIntersecting)) {
                    setVisible(true);
                    observer.disconnect();
                }
            },
            { rootMargin: "120px" }
        );
        observer.observe(el);
        return () => observer.disconnect();
    }, [item.key]);

    useEffect(() => {
        if (!visible) return;
        let cancelled = false;
        let objectUrl: string | null = null;

        setFailed(false);
        getOrFetchThumbnailBlob(tauriBridge, item, pack, onPackUpdated)
            .then(blob => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setPosterSrc(objectUrl);
            })
            .catch(() => {
                if (!cancelled) setFailed(true);
            });

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [visible, item.key, item.posterUrl, item.mediaUrl]);

    useEffect(() => {
        if (!hovered || !isAnimated) return;
        let cancelled = false;
        let objectUrl: string | null = null;

        getOrFetchPreviewBlob(tauriBridge, item, pack, onPackUpdated)
            .then(blob => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setIsVideoPreview(blob.type.startsWith("video/"));
                setPreviewSrc(objectUrl);
            })
            .catch(() => {});

        return () => {
            cancelled = true;
            setPreviewSrc(null);
            setIsVideoPreview(false);
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [hovered, isAnimated, item.key, item.mediaUrl, item.origUrl]);

    const activeSrc = hovered && previewSrc ? previewSrc : posterSrc;

    return (
        <div
            ref={tileRef}
            className={`dc-ke-item${isBusy ? " busy" : ""}`}
            title={item.title || `${pack.title} #${item.id}`}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onClick={() => onSelect(item, pack)}
        >
            {activeSrc ? (
                hovered && previewSrc && isVideoPreview ? (
                    <video
                        className="dc-ke-item-img"
                        src={activeSrc}
                        autoPlay
                        loop
                        muted
                        playsInline
                    />
                ) : (
                    <img
                        className="dc-ke-item-img"
                        src={activeSrc}
                        alt={item.title || item.id}
                        draggable={false}
                    />
                )
            ) : (
                <span className="dc-ke-item-placeholder">{failed ? "실패" : "..."}</span>
            )}
            {isAnimated ? (
                <span className="dc-ke-badge">
                    {item.type === "video" ? "움짤" : item.ext?.toUpperCase()}
                </span>
            ) : null}
            <button
                type="button"
                className={`dc-ke-fav-btn${isFavorite ? " is-fav" : ""}`}
                title={isFavorite ? "즐겨찾기 해제" : "즐겨찾기 추가"}
                onClick={e => {
                    e.stopPropagation();
                    onToggleFavorite(item.key);
                }}
            >
                {isFavorite ? "★" : "☆"}
            </button>
        </div>
    );
}

export function EmoticonPicker() {
    const [packs, setPacks] = useState<EmoticonPack[]>([]);
    const [recent, setRecent] = useState<string[]>([]);
    const [favorites, setFavorites] = useState<string[]>([]);
    const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
    const [loaded, setLoaded] = useState(false);

    const [activeTab, setActiveTab] = useState<ActiveTab>("recent");
    const [search, setSearch] = useState("");
    const [resizeSize, setResizeSize] = useState<ResizeOption>(120);
    const [busyKey, setBusyKey] = useState<string | null>(null);

    const [packUrlInput, setPackUrlInput] = useState("");
    const [addingPack, setAddingPack] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);

    const [settingsOpen, setSettingsOpen] = useState(false);
    const [toast, setToast] = useState<ToastState | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const toastTimerRef = useRef<number | null>(null);

    const notify = useCallback((text: string, variant: "success" | "error" | "info" = "info") => {
        setToast({ text, variant });
        if (toastTimerRef.current) {
            window.clearTimeout(toastTimerRef.current);
        }
        toastTimerRef.current = window.setTimeout(() => {
            setToast(null);
        }, 2500);
    }, []);

    useEffect(() => {
        const root = document.documentElement;
        if (settings.theme === "light" || settings.theme === "dark") {
            root.dataset.theme = settings.theme;
            return;
        }

        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const applySystemTheme = () => {
            root.dataset.theme = media.matches ? "dark" : "light";
        };
        applySystemTheme();

        media.addEventListener("change", applySystemTheme);
        return () => media.removeEventListener("change", applySystemTheme);
    }, [settings.theme]);

    useEffect(() => {
        Promise.all([tauriStorage.loadMetadata(), tauriStorage.loadSettings()]).then(
            ([meta, loadedSettings]) => {
                setPacks(meta.packs);
                setRecent(meta.recent);
                setFavorites(meta.favorites);
                setSettings(loadedSettings);
                setResizeSize(loadedSettings.resizeOption);

                if (loadedSettings.shortcut && loadedSettings.shortcut !== "Alt+E") {
                    void registerOverlayShortcut(loadedSettings.shortcut).catch(err => {
                        notify(err instanceof Error ? err.message : String(err), "error");
                    });
                }

                if (meta.packs.length === 0) {
                    setActiveTab("add");
                } else if (meta.recent.length === 0) {
                    setActiveTab(meta.packs[0].id);
                }
                setLoaded(true);
                void checkAndAutoInstallUpdate({
                    silent: true,
                    onStatus: (msg, variant) => notify(msg, variant ?? "info"),
                });
            }
        );
    }, [notify]);

    useEffect(() => {
        const onWindowFocus = () => {
            searchInputRef.current?.focus();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                if (settingsOpen) {
                    setSettingsOpen(false);
                } else {
                    void hideOverlayWindow();
                }
            }
        };
        window.addEventListener("focus", onWindowFocus);
        window.addEventListener("keydown", onKeyDown);

        const unlistenSettings = listen("open-settings", () => {
            setSettingsOpen(true);
        });
        const unlistenShortcutErr = listen<string>("shortcut-error", event => {
            notify(event.payload, "error");
        });

        return () => {
            window.removeEventListener("focus", onWindowFocus);
            window.removeEventListener("keydown", onKeyDown);
            void unlistenSettings.then(fn => fn());
            void unlistenShortcutErr.then(fn => fn());
        };
    }, [settingsOpen, notify]);

    const itemLookup = useMemo(() => {
        const map = new Map<string, { item: EmoticonItem; pack: EmoticonPack }>();
        for (const pack of packs) {
            for (const item of pack.items) {
                map.set(item.key, { item, pack });
            }
        }
        return map;
    }, [packs]);

    const handlePackUpdated = useCallback((updated: EmoticonPack) => {
        setPacks(prev => {
            const next = prev.map(p => (p.id === updated.id ? updated : p));
            void tauriStorage.savePacks(next);
            return next;
        });
    }, []);

    const handleAddPack = async (e?: React.FormEvent) => {
        e?.preventDefault();
        setAddError(null);

        const parsed = parsePackInput(packUrlInput);
        if (!parsed) {
            setAddError("올바른 아카라이브(/e/번호) 또는 디시콘 URL을 입력하세요.");
            return;
        }

        const targetId = `${parsed.source}:${parsed.packId}`;
        if (packs.some(p => p.id === targetId)) {
            setActiveTab(targetId);
            setPackUrlInput("");
            return;
        }

        setAddingPack(true);
        try {
            const newPack = await fetchPackMetadata(tauriBridge, parsed.source, parsed.packId);
            if (newPack.items.length === 0) {
                throw new Error("등록할 콘이 없습니다.");
            }
            const next = [...packs, newPack];
            setPacks(next);
            await tauriStorage.savePacks(next);
            setPackUrlInput("");
            setActiveTab(newPack.id);
            notify(`"${newPack.title}" 팩이 등록되었습니다.`, "success");
        } catch (err) {
            setAddError(getErrorMessage(err, "팩을 불러오지 못했습니다."));
        } finally {
            setAddingPack(false);
        }
    };

    const handleSelectEmoticon = async (item: EmoticonItem, pack: EmoticonPack) => {
        if (busyKey) return;
        setBusyKey(item.key);
        try {
            const { blob, ext } = await prepareEmoticonForUpload(
                tauriBridge,
                item,
                pack,
                resizeSize,
                handlePackUpdated
            );

            await copyMediaToClipboard(
                {
                    source: item.source,
                    packId: item.packId,
                    itemId: item.id,
                    resize: resizeSize,
                    ext,
                },
                blob
            );

            const nextRecent = addRecentKey(recent, item.key);
            setRecent(nextRecent);
            await tauriStorage.saveRecent(nextRecent);

            notify("붙여넣기 완료!", "success");
        } catch (err) {
            notify(getErrorMessage(err, "붙여넣기 실패"), "error");
        } finally {
            setBusyKey(null);
        }
    };

    const handleToggleFavorite = async (key: string) => {
        const next = toggleFavoriteKey(favorites, key);
        setFavorites(next);
        await tauriStorage.saveFavorites(next);
    };

    const activePack = packs.find(p => p.id === activeTab) ?? null;

    const handleMovePack = async (delta: -1 | 1) => {
        if (!activePack) return;
        const idx = packs.findIndex(p => p.id === activePack.id);
        const nextIdx = idx + delta;
        if (idx < 0 || nextIdx < 0 || nextIdx >= packs.length) return;
        const next = [...packs];
        [next[idx], next[nextIdx]] = [next[nextIdx], next[idx]];
        setPacks(next);
        await tauriStorage.savePacks(next);
    };

    const handleDeletePack = async () => {
        if (!activePack) return;
        const next = packs.filter(p => p.id !== activePack.id);
        setPacks(next);
        await tauriStorage.savePacks(next);
        await deleteCachedBlobsByPrefix(`${activePack.id}:`);
        setActiveTab(next[0]?.id ?? "add");
        notify(`"${activePack.title}" 팩을 삭제했습니다.`, "info");
    };

    const handleRefreshPack = async () => {
        if (!activePack) return;
        try {
            const updated = await refreshPack(tauriBridge, activePack, handlePackUpdated);
            notify(`"${updated.title}" 팩을 새로고침했습니다.`, "success");
        } catch (err) {
            notify(getErrorMessage(err, "새로고침 실패"), "error");
        }
    };

    const handleRenamePack = (pack: EmoticonPack, newTitle: string) => {
        handlePackUpdated({ ...pack, title: newTitle });
    };

    const handleResizeSelect = (value: string) => {
        const parsed = Number(value) as ResizeOption;
        setResizeSize(parsed);
        const nextSettings = { ...settings, resizeOption: parsed };
        setSettings(nextSettings);
        void tauriStorage.saveSettings(nextSettings);
    };

    const handleSaveSettings = async (next: AppSettings) => {
        setSettings(next);
        setResizeSize(next.resizeOption);
        await tauriStorage.saveSettings(next);
    };

    const visibleEntries = useMemo(() => {
        const q = search.trim().toLowerCase();
        let list: Array<{ item: EmoticonItem; pack: EmoticonPack }> = [];

        if (activeTab === "recent") {
            list = recent
                .map(k => itemLookup.get(k))
                .filter((v): v is { item: EmoticonItem; pack: EmoticonPack } => Boolean(v));
        } else if (activeTab === "favorites") {
            list = favorites
                .map(k => itemLookup.get(k))
                .filter((v): v is { item: EmoticonItem; pack: EmoticonPack } => Boolean(v));
        } else if (activePack) {
            list = activePack.items.map(item => ({ item, pack: activePack }));
        }

        if (!q) return list;
        return list.filter(
            ({ item, pack }) =>
                (item.title?.toLowerCase().includes(q) ?? false) ||
                pack.title.toLowerCase().includes(q) ||
                item.id.toLowerCase().includes(q)
        );
    }, [activeTab, activePack, recent, favorites, itemLookup, search]);

    if (!loaded) {
        return (
            <div className="dc-ke-shell">
                <div className="dc-ke-empty" style={{ width: "100%" }}>
                    불러오는 중...
                </div>
            </div>
        );
    }

    return (
        <div className="dc-ke-shell">
            <div className="dc-ke-titlebar" data-tauri-drag-region>
                <div className="dc-ke-titlebar-left" data-tauri-drag-region>
                    <span className="dc-ke-app-name" data-tauri-drag-region>
                        여기서까지콘을써야겠냐
                    </span>
                    <span className="dc-ke-shortcut-pill">{settings.shortcut}</span>
                </div>
                <div className="dc-ke-titlebar-actions">
                    <button
                        type="button"
                        className="dc-ke-icon-btn"
                        title="설정"
                        onClick={() => setSettingsOpen(true)}
                    >
                        ⚙
                    </button>
                    <button
                        type="button"
                        className="dc-ke-icon-btn"
                        title="닫기 (Esc)"
                        onClick={() => void hideOverlayWindow()}
                    >
                        ✕
                    </button>
                </div>
            </div>

            <div className="dc-ke-body">
                <div className="dc-ke-sidebar">
                    <button
                        type="button"
                        className={`dc-ke-tab-btn${activeTab === "recent" ? " active" : ""}`}
                        title="최근 사용"
                        onClick={() => setActiveTab("recent")}
                    >
                        🕒
                    </button>
                    <button
                        type="button"
                        className={`dc-ke-tab-btn${activeTab === "favorites" ? " active" : ""}`}
                        title="즐겨찾기"
                        onClick={() => setActiveTab("favorites")}
                    >
                        ★
                    </button>
                    <div className="dc-ke-tab-divider" />
                    {packs.map(pack => (
                        <button
                            key={pack.id}
                            type="button"
                            className={`dc-ke-tab-btn${activeTab === pack.id ? " active" : ""}`}
                            title={pack.title}
                            onClick={() => setActiveTab(pack.id)}
                        >
                            <PackTabThumb pack={pack} onPackUpdated={handlePackUpdated} />
                        </button>
                    ))}
                    <div className="dc-ke-tab-divider" />
                    <button
                        type="button"
                        className={`dc-ke-tab-btn${activeTab === "add" ? " active" : ""}`}
                        title="팩 등록"
                        onClick={() => setActiveTab("add")}
                    >
                        ＋
                    </button>
                </div>

                <div className="dc-ke-main">
                    <div className="dc-ke-header">
                        <div className="dc-ke-search-row">
                            <input
                                ref={searchInputRef}
                                className="dc-ke-input"
                                type="text"
                                placeholder="콘 검색..."
                                value={search}
                                onChange={e => setSearch(e.target.value)}
                            />
                            <select
                                className="dc-ke-select"
                                title="전송 크기"
                                value={String(resizeSize)}
                                onChange={e => handleResizeSelect(e.target.value)}
                            >
                                <option value="120">120px</option>
                                <option value="160">160px</option>
                                <option value="0">원본</option>
                            </select>
                        </div>

                        <PackBar
                            activePack={activePack}
                            activeTab={activeTab}
                            onRenamePack={handleRenamePack}
                            onMovePack={delta => void handleMovePack(delta)}
                            onRefreshPack={() => void handleRefreshPack()}
                            onDeletePack={() => void handleDeletePack()}
                        />
                    </div>

                    <div className="dc-ke-content">
                        {activeTab === "add" ? (
                            <AddPackPanel
                                packUrlInput={packUrlInput}
                                addingPack={addingPack}
                                addError={addError}
                                onChangeInput={setPackUrlInput}
                                onSubmit={handleAddPack}
                            />
                        ) : visibleEntries.length === 0 ? (
                            <div className="dc-ke-empty">
                                <span>
                                    {activeTab === "recent"
                                        ? "최근 사용한 콘이 없습니다."
                                        : activeTab === "favorites"
                                          ? "즐겨찾기한 콘이 없습니다."
                                          : "일치하는 콘이 없습니다."}
                                </span>
                                {packs.length === 0 && (
                                    <button
                                        type="button"
                                        className="dc-ke-btn"
                                        onClick={() => setActiveTab("add")}
                                    >
                                        팩 등록하기
                                    </button>
                                )}
                            </div>
                        ) : (
                            <div className="dc-ke-grid">
                                {visibleEntries.map(({ item, pack }) => (
                                    <EmoticonTile
                                        key={item.key}
                                        item={item}
                                        pack={pack}
                                        isFavorite={favorites.includes(item.key)}
                                        isBusy={busyKey === item.key}
                                        onSelect={handleSelectEmoticon}
                                        onToggleFavorite={handleToggleFavorite}
                                        onPackUpdated={handlePackUpdated}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {toast && <div className={`dc-ke-toast ${toast.variant}`}>{toast.text}</div>}

            {settingsOpen && (
                <SettingsModal
                    settings={settings}
                    onSaveSettings={handleSaveSettings}
                    onClose={() => setSettingsOpen(false)}
                    onNotify={notify}
                />
            )}
        </div>
    );
}
