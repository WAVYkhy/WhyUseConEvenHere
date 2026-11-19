import {
    type AppSettings,
    DEFAULT_APP_SETTINGS,
    type EmoticonMetadata,
    type EmoticonPack,
    type MetadataStorage,
} from "@discordcon/core";
import { load, type Store } from "@tauri-apps/plugin-store";

const STORE_FILE = "store.json";
const PACKS_KEY = "packs";
const RECENT_KEY = "recent";
const FAVORITES_KEY = "favorites";
const SETTINGS_KEY = "settings";
const MAX_RECENT = 40;

let storePromise: Promise<Store> | null = null;

function getStore(): Promise<Store> {
    if (!storePromise) {
        storePromise = load(STORE_FILE);
    }
    return storePromise;
}

export const tauriStorage: MetadataStorage = {
    async loadMetadata(): Promise<EmoticonMetadata> {
        const store = await getStore();
        const [packs, recent, favorites] = await Promise.all([
            store.get<EmoticonPack[]>(PACKS_KEY),
            store.get<string[]>(RECENT_KEY),
            store.get<string[]>(FAVORITES_KEY),
        ]);

        return {
            packs: Array.isArray(packs) ? packs : [],
            recent: Array.isArray(recent) ? recent : [],
            favorites: Array.isArray(favorites) ? favorites : [],
        };
    },

    async savePacks(packs: EmoticonPack[]): Promise<void> {
        const store = await getStore();
        await store.set(PACKS_KEY, packs);
        await store.save();
    },

    async saveRecent(recent: string[]): Promise<void> {
        const store = await getStore();
        await store.set(RECENT_KEY, recent.slice(0, MAX_RECENT));
        await store.save();
    },

    async saveFavorites(favorites: string[]): Promise<void> {
        const store = await getStore();
        await store.set(FAVORITES_KEY, favorites);
        await store.save();
    },

    async loadSettings(): Promise<AppSettings> {
        const store = await getStore();
        const saved = await store.get<Partial<AppSettings>>(SETTINGS_KEY);
        return {
            ...DEFAULT_APP_SETTINGS,
            ...(saved ?? {}),
        };
    },

    async saveSettings(settings: AppSettings): Promise<void> {
        const store = await getStore();
        await store.set(SETTINGS_KEY, settings);
        await store.save();
    },
};
