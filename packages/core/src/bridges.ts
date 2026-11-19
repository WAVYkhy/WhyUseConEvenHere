import type {
    AppSettings,
    ArcaEmoticonRaw,
    DcPackageDetailRaw,
    EmoticonMetadata,
    EmoticonPack,
    EmoticonSource,
    NativeMediaResponse,
} from "./types.js";

export interface NativeBridge {
    fetchArcaPack(packId: string): Promise<ArcaEmoticonRaw[]>;
    fetchDcPack(packId: string): Promise<DcPackageDetailRaw>;
    fetchMedia(url: string, source: EmoticonSource): Promise<NativeMediaResponse>;
}

export interface MetadataStorage {
    loadMetadata(): Promise<EmoticonMetadata>;
    savePacks(packs: EmoticonPack[]): Promise<void>;
    saveRecent(recent: string[]): Promise<void>;
    saveFavorites(favorites: string[]): Promise<void>;
    loadSettings(): Promise<AppSettings>;
    saveSettings(settings: AppSettings): Promise<void>;
}
