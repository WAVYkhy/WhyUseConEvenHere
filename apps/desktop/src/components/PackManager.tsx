import type { EmoticonPack } from "@discordcon/core";
import React, { useState } from "react";
import { openExternalUrl } from "../adapters/tauriBridge";

interface PackBarProps {
    activePack: EmoticonPack | null;
    activeTab: string;
    onRenamePack: (pack: EmoticonPack, newTitle: string) => void;
    onMovePack: (delta: -1 | 1) => void;
    onRefreshPack: () => void;
    onDeletePack: () => void;
}

export function PackBar({
    activePack,
    activeTab,
    onRenamePack,
    onMovePack,
    onRefreshPack,
    onDeletePack,
}: PackBarProps) {
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");

    const commitTitle = () => {
        if (activePack) {
            const trimmed = titleDraft.trim();
            if (trimmed) {
                onRenamePack(activePack, trimmed);
            }
        }
        setEditingTitle(false);
    };

    if (!activePack) {
        return (
            <div className="dc-ke-pack-bar">
                <span className="dc-ke-pack-title">
                    {activeTab === "recent"
                        ? "최근 사용한 콘"
                        : activeTab === "favorites"
                          ? "즐겨찾기"
                          : "새 콘 팩 등록"}
                </span>
            </div>
        );
    }

    return (
        <div className="dc-ke-pack-bar">
            {editingTitle ? (
                <input
                    className="dc-ke-input"
                    style={{ height: 24, fontSize: 12 }}
                    value={titleDraft}
                    autoFocus
                    onChange={e => setTitleDraft(e.target.value)}
                    onBlur={commitTitle}
                    onKeyDown={e => {
                        if (e.key === "Enter") commitTitle();
                        if (e.key === "Escape") {
                            e.stopPropagation();
                            setEditingTitle(false);
                        }
                    }}
                />
            ) : (
                <span className="dc-ke-pack-title">{activePack.title}</span>
            )}
            <div className="dc-ke-pack-actions">
                <button
                    type="button"
                    className="dc-ke-icon-btn"
                    title="이름 편집"
                    onClick={() => {
                        setTitleDraft(activePack.title);
                        setEditingTitle(true);
                    }}
                >
                    ✎
                </button>
                <button
                    type="button"
                    className="dc-ke-icon-btn"
                    title="위로 이동"
                    onClick={() => onMovePack(-1)}
                >
                    ▲
                </button>
                <button
                    type="button"
                    className="dc-ke-icon-btn"
                    title="아래로 이동"
                    onClick={() => onMovePack(1)}
                >
                    ▼
                </button>
                <button
                    type="button"
                    className="dc-ke-icon-btn"
                    title="URL 새로고침"
                    onClick={onRefreshPack}
                >
                    ↻
                </button>
                <button
                    type="button"
                    className="dc-ke-icon-btn danger"
                    title="팩 삭제"
                    onClick={onDeletePack}
                >
                    ✕
                </button>
            </div>
        </div>
    );
}

interface AddPackPanelProps {
    packUrlInput: string;
    addingPack: boolean;
    addError: string | null;
    onChangeInput: (val: string) => void;
    onSubmit: (e?: React.FormEvent) => void;
}

export function AddPackPanel({
    packUrlInput,
    addingPack,
    addError,
    onChangeInput,
    onSubmit,
}: AddPackPanelProps) {
    return (
        <form className="dc-ke-add-panel" onSubmit={onSubmit}>
            <h3>아카콘 / 디시콘 등록</h3>
            <p className="dc-ke-add-desc">
                아카라이브 콘 URL(예: <code>https://arca.live/e/53122</code>) 또는
                디시콘 URL(예: <code>https://dccon.dcinside.com/#12345</code>), 단축 입력(
                <code>arca:53122</code>, <code>dc:12345</code>)을 입력하세요.
            </p>
            <div className="dc-ke-add-links">
                <button
                    type="button"
                    className="dc-ke-link-btn"
                    onClick={() => void openExternalUrl("https://arca.live/e/?p=")}
                >
                    아카콘 검색 ↗
                </button>
                <button
                    type="button"
                    className="dc-ke-link-btn"
                    onClick={() => void openExternalUrl("https://dccon.dcinside.com/")}
                >
                    디시콘 검색 ↗
                </button>
            </div>
            <input
                className="dc-ke-input"
                type="text"
                placeholder="https://arca.live/e/53122"
                value={packUrlInput}
                onChange={e => onChangeInput(e.target.value)}
                disabled={addingPack}
                autoFocus
            />
            {addError && <div className="dc-ke-error">{addError}</div>}
            <button type="submit" className="dc-ke-btn" disabled={addingPack}>
                {addingPack ? "불러오는 중..." : "팩 등록하기"}
            </button>
        </form>
    );
}
