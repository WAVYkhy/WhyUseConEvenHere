import type {
    ArcaEmoticonRaw,
    DcPackageDetailRaw,
    EmoticonSource,
    NativeBridge,
    NativeMediaResponse,
    ResizeOption,
} from "@discordcon/core";
import { invoke } from "@tauri-apps/api/core";

export interface ClipboardCopyMeta {
    source: EmoticonSource;
    packId: string;
    itemId: string;
    resize: ResizeOption;
    ext: "gif" | "png" | "jpg" | "jpeg" | "webp";
}

export const tauriBridge: NativeBridge = {
    async fetchArcaPack(packId: string): Promise<ArcaEmoticonRaw[]> {
        return invoke<ArcaEmoticonRaw[]>("fetch_arca_pack", { packId });
    },

    async fetchDcPack(packId: string): Promise<DcPackageDetailRaw> {
        return invoke<DcPackageDetailRaw>("fetch_dc_pack", { packId });
    },

    async fetchMedia(url: string, source: EmoticonSource): Promise<NativeMediaResponse> {
        const buffer = await invoke<ArrayBuffer>("fetch_media", { url, source });
        const bytes = new Uint8Array(buffer);
        if (bytes.byteLength < 4) {
            throw new Error("Invalid binary media frame from backend");
        }

        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const status = view.getUint16(0, true);
        const mimeLen = view.getUint16(2, true);
        const payloadOffset = 4 + mimeLen;
        if (bytes.byteLength < payloadOffset) {
            throw new Error("Truncated binary media frame from backend");
        }

        const contentType = new TextDecoder().decode(bytes.subarray(4, payloadOffset));
        const data = bytes.slice(payloadOffset);
        return { status, contentType, data };
    },
};

export async function copyMediaToClipboard(
    meta: ClipboardCopyMeta,
    blob: Blob
): Promise<void> {
    const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
    const mediaBytes = new Uint8Array(await blob.arrayBuffer());

    const framed = new Uint8Array(4 + metaBytes.byteLength + mediaBytes.byteLength);
    const view = new DataView(framed.buffer);
    view.setUint32(0, metaBytes.byteLength, true);
    framed.set(metaBytes, 4);
    framed.set(mediaBytes, 4 + metaBytes.byteLength);

    await invoke("copy_media_to_clipboard", framed);
}

export async function hideOverlayWindow(): Promise<void> {
    await invoke("hide_overlay_window");
}

export async function setBlurSuppressed(suppressed: boolean): Promise<void> {
    await invoke("set_blur_suppressed", { suppressed });
}

export async function registerOverlayShortcut(shortcut: string): Promise<void> {
    await invoke("register_overlay_shortcut", { shortcut });
}

export async function openExternalUrl(url: string): Promise<void> {
    await invoke("open_external_url", { url });
}

export async function isAutostartEnabled(): Promise<boolean> {
    return invoke<boolean>("is_autostart_enabled");
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
    await invoke("set_autostart", { enabled });
}
