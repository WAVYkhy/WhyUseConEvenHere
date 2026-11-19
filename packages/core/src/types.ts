export type EmoticonSource = "arca" | "dc";

export type ResizeOption = 120 | 160 | 0;

export type ThemeMode = "system" | "light" | "dark";

export interface EmoticonItem {
    id: string;
    key: string;
    source: EmoticonSource;
    packId: string;
    title?: string;
    mediaUrl: string;
    posterUrl?: string;
    origUrl?: string;
    type: "image" | "video";
    ext?: string;
}

export interface EmoticonPack {
    id: string;
    source: EmoticonSource;
    packId: string;
    title: string;
    thumbnailUrl?: string;
    items: EmoticonItem[];
    addedAt: number;
    lastRefreshedAt?: number;
    expiresAt?: number;
}

export interface EmoticonMetadata {
    packs: EmoticonPack[];
    recent: string[];
    favorites: string[];
}

export interface AppSettings {
    resizeOption: ResizeOption;
    shortcut: string;
    autoStart: boolean;
    theme: ThemeMode;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
    resizeOption: 120,
    shortcut: "Alt+E",
    autoStart: false,
    theme: "system",
};

export interface NativeMediaResponse {
    status: number;
    contentType: string;
    data: Uint8Array;
}

export interface ArcaEmoticonRaw {
    id: number | string;
    imageUrl: string;
    type: "image" | "video" | string;
    poster?: string;
    orig?: string;
}

export interface DcPackageDetailRaw {
    info?: {
        package_idx?: string | number;
        title?: string;
        main_img_path?: string;
    };
    detail?: Array<{
        idx: string | number;
        title?: string;
        ext?: string;
        path: string;
    }>;
}
