import type { NativeBridge } from "./bridges.js";
import { getCachedBlob, putCachedBlob } from "./cache.js";
import type { EmoticonItem, EmoticonPack, EmoticonSource } from "./types.js";

const EXPIRY_BUFFER_MS = 10 * 60 * 1000;
const inflightRefreshes = new Map<string, Promise<EmoticonPack>>();

export function parsePackInput(input: string): { source: EmoticonSource; packId: string } | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    const shortMatch = trimmed.match(/^(arca|dc):(\d+)$/i);
    if (shortMatch) {
        return {
            source: shortMatch[1].toLowerCase() as EmoticonSource,
            packId: shortMatch[2],
        };
    }

    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const url = new URL(withScheme);
        const host = url.hostname.toLowerCase();

        if (host === "arca.live" || host.endsWith(".arca.live")) {
            const m = url.pathname.match(/\/e\/(\d+)/);
            if (m) return { source: "arca", packId: m[1] };
        }

        if (host === "dccon.dcinside.com" || host.endsWith(".dcinside.com")) {
            const idxParam = url.searchParams.get("package_idx");
            if (idxParam && /^\d+$/.test(idxParam)) {
                return { source: "dc", packId: idxParam };
            }
            const hashMatch = url.hash.match(/#(\d+)/);
            if (hashMatch) return { source: "dc", packId: hashMatch[1] };

            const pathMatch = url.pathname.match(/\/(\d+)(?:\/|$)/);
            if (pathMatch) return { source: "dc", packId: pathMatch[1] };
        }
    } catch {
        return null;
    }

    return null;
}

export function normalizeUrl(url?: string): string {
    if (!url) return "";
    if (url.startsWith("//")) return `https:${url}`;
    if (url.startsWith("http://")) return `https://${url.slice(7)}`;
    return url;
}

function extractExtFromUrl(url: string): string | undefined {
    try {
        const pathname = new URL(url).pathname;
        const match = pathname.match(/\.([a-z0-9]+)$/i);
        return match ? match[1].toLowerCase() : undefined;
    } catch {
        return undefined;
    }
}

function extractExpiresMs(url: string): number | undefined {
    try {
        const expires = new URL(url).searchParams.get("expires");
        if (!expires) return undefined;
        const num = Number(expires);
        if (!Number.isFinite(num) || num <= 0) return undefined;
        return num < 1e12 ? num * 1000 : num;
    } catch {
        return undefined;
    }
}

export async function fetchPackMetadata(
    bridge: NativeBridge,
    source: EmoticonSource,
    packId: string,
    existingTitle?: string,
    addedAt?: number
): Promise<EmoticonPack> {
    const now = Date.now();
    const id = `${source}:${packId}`;

    if (source === "arca") {
        const rawList = await bridge.fetchArcaPack(packId);
        let minExpiresAt: number | undefined;

        const items: EmoticonItem[] = rawList.map(raw => {
            const mediaUrl = normalizeUrl(raw.imageUrl);
            const posterUrl = normalizeUrl(raw.poster || raw.imageUrl);
            const origUrl = raw.orig ? normalizeUrl(raw.orig) : undefined;
            const itemId = String(raw.id);

            const exp = extractExpiresMs(mediaUrl) ?? extractExpiresMs(posterUrl);
            if (exp !== undefined && (minExpiresAt === undefined || exp < minExpiresAt)) {
                minExpiresAt = exp;
            }

            const ext = extractExtFromUrl(origUrl || mediaUrl);
            const isVideo = raw.type === "video" || ext === "mp4" || ext === "webm";

            return {
                id: itemId,
                key: `${id}:${itemId}`,
                source: "arca",
                packId,
                mediaUrl,
                posterUrl,
                origUrl,
                type: isVideo ? "video" : "image",
                ext,
            };
        });

        return {
            id,
            source: "arca",
            packId,
            title: existingTitle?.trim() || `아카콘 #${packId}`,
            thumbnailUrl: items[0]?.posterUrl || items[0]?.mediaUrl,
            items,
            addedAt: addedAt ?? now,
            lastRefreshedAt: now,
            expiresAt: minExpiresAt,
        };
    }

    const rawDc = await bridge.fetchDcPack(packId);
    const infoTitle = rawDc.info?.title?.trim();
    const detailList = rawDc.detail ?? [];

    const items: EmoticonItem[] = detailList.map(d => {
        const itemId = String(d.idx);
        const mediaUrl = `https://dcimg5.dcinside.com/dccon.php?no=${encodeURIComponent(d.path)}`;
        const ext = d.ext?.toLowerCase();
        return {
            id: itemId,
            key: `${id}:${itemId}`,
            source: "dc",
            packId,
            title: d.title?.trim() || undefined,
            mediaUrl,
            posterUrl: mediaUrl,
            type: ext === "mp4" ? "video" : "image",
            ext,
        };
    });

    const mainImgPath = rawDc.info?.main_img_path;
    const thumbnailUrl = mainImgPath
        ? `https://dcimg5.dcinside.com/dccon.php?no=${encodeURIComponent(mainImgPath)}`
        : items[0]?.posterUrl;

    return {
        id,
        source: "dc",
        packId,
        title: existingTitle?.trim() || infoTitle || `디시콘 #${packId}`,
        thumbnailUrl,
        items,
        addedAt: addedAt ?? now,
        lastRefreshedAt: now,
    };
}

export function isPackExpired(pack: EmoticonPack): boolean {
    if (pack.source !== "arca") return false;
    if (!pack.expiresAt) return false;
    return Date.now() + EXPIRY_BUFFER_MS >= pack.expiresAt;
}

export async function refreshPack(
    bridge: NativeBridge,
    pack: EmoticonPack,
    onPackUpdated?: (updated: EmoticonPack) => void
): Promise<EmoticonPack> {
    const existing = inflightRefreshes.get(pack.id);
    if (existing) return existing;

    const promise = fetchPackMetadata(bridge, pack.source, pack.packId, pack.title, pack.addedAt)
        .then(updated => {
            onPackUpdated?.(updated);
            return updated;
        })
        .finally(() => {
            inflightRefreshes.delete(pack.id);
        });

    inflightRefreshes.set(pack.id, promise);
    return promise;
}

export async function fetchMediaBlob(
    bridge: NativeBridge,
    item: EmoticonItem,
    pack: EmoticonPack,
    kind: "poster" | "media" | "orig",
    onPackUpdated?: (updated: EmoticonPack) => void
): Promise<{ blob: Blob; contentType: string; pack: EmoticonPack }> {
    let activePack = pack;
    let activeItem = item;

    if (activePack.source === "arca" && isPackExpired(activePack)) {
        activePack = await refreshPack(bridge, activePack, onPackUpdated);
        activeItem = activePack.items.find(i => i.id === item.id) ?? activeItem;
    }

    const pickUrl = (it: EmoticonItem): string => {
        if (kind === "poster") return it.posterUrl || it.mediaUrl;
        if (kind === "orig") return it.origUrl || it.mediaUrl;
        return it.mediaUrl;
    };

    let targetUrl = pickUrl(activeItem);
    let res = await bridge.fetchMedia(targetUrl, activeItem.source);

    if ((res.status === 403 || res.status === 410) && activePack.source === "arca") {
        activePack = await refreshPack(bridge, activePack, onPackUpdated);
        activeItem = activePack.items.find(i => i.id === item.id) ?? activeItem;
        targetUrl = pickUrl(activeItem);
        res = await bridge.fetchMedia(targetUrl, activeItem.source);
    }

    if (res.status < 200 || res.status >= 300 || res.data.byteLength === 0) {
        throw new Error(`미디어 다운로드 실패 (HTTP ${res.status})`);
    }

    const contentType = res.contentType || "application/octet-stream";
    const bytes = new Uint8Array(res.data);
    const blob = new Blob([bytes], { type: contentType });
    return { blob, contentType, pack: activePack };
}

export async function getOrFetchThumbnailBlob(
    bridge: NativeBridge,
    item: EmoticonItem,
    pack: EmoticonPack,
    onPackUpdated?: (updated: EmoticonPack) => void
): Promise<Blob> {
    const cacheKey = `thumb:${item.key}`;
    const cached = await getCachedBlob(cacheKey);
    if (cached && cached.size > 0) return cached;

    const { blob } = await fetchMediaBlob(bridge, item, pack, "poster", onPackUpdated);
    await putCachedBlob(cacheKey, blob);
    return blob;
}

export async function getOrFetchPreviewBlob(
    bridge: NativeBridge,
    item: EmoticonItem,
    pack: EmoticonPack,
    onPackUpdated?: (updated: EmoticonPack) => void
): Promise<Blob> {
    const kind = item.origUrl ? "orig" : "media";
    const cacheKey = `preview:${item.key}:${kind}`;
    const cached = await getCachedBlob(cacheKey);
    if (cached && cached.size > 0) return cached;

    const { blob } = await fetchMediaBlob(bridge, item, pack, kind, onPackUpdated);
    await putCachedBlob(cacheKey, blob);
    return blob;
}
