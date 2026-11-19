import { applyPalette, GIFEncoder, quantize } from "gifenc";

import { fetchMediaBlob } from "./api.js";
import type { NativeBridge } from "./bridges.js";
import { getCachedBlob, putCachedBlob } from "./cache.js";
import type { EmoticonItem, EmoticonPack, ResizeOption } from "./types.js";
import { GIF_WORKER_SOURCE } from "./workerSource.js";

const MAX_UPLOAD_BYTES = 9 * 1024 * 1024;
const MP4_FPS = 15;
const MP4_MAX_FRAMES = 90;

interface PendingWorkerJob {
    resolve: (value: { buffer: ArrayBuffer; mimeType: string }) => void;
    reject: (reason?: unknown) => void;
}

let worker: Worker | null = null;
let workerUrl: string | null = null;
let workerDisabled = false;
let nextJobId = 1;
const pendingJobs = new Map<number, PendingWorkerJob>();

function getWorker(): Worker {
    if (workerDisabled) {
        throw new Error("Worker disabled");
    }
    if (worker) return worker;

    const blob = new Blob([GIF_WORKER_SOURCE], { type: "application/javascript" });
    workerUrl = URL.createObjectURL(blob);
    worker = new Worker(workerUrl);

    worker.onmessage = (event: MessageEvent) => {
        const { id, ok, buffer, mimeType, error } = event.data;
        const job = pendingJobs.get(id);
        if (!job) return;
        pendingJobs.delete(id);

        if (ok) {
            job.resolve({ buffer, mimeType });
        } else {
            job.reject(new Error(error || "Worker conversion failed"));
        }
    };

    worker.onerror = (err) => {
        workerDisabled = true;
        for (const [id, job] of pendingJobs) {
            pendingJobs.delete(id);
            job.reject(new Error(err.message || "Worker error"));
        }
        terminateConverterWorker();
    };

    return worker;
}

export function terminateConverterWorker(): void {
    if (worker) {
        worker.terminate();
        worker = null;
    }
    if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
        workerUrl = null;
    }
    for (const [id, job] of pendingJobs) {
        pendingJobs.delete(id);
        job.reject(new Error("Converter worker terminated"));
    }
}

function runWorkerTask(
    payload: Record<string, unknown>,
    transfer: Transferable[]
): Promise<{ buffer: ArrayBuffer; mimeType: string }> {
    const w = getWorker();
    const id = nextJobId++;
    return new Promise((resolve, reject) => {
        pendingJobs.set(id, { resolve, reject });
        w.postMessage({ ...payload, id }, transfer);
    });
}

function detectMimeType(bytes: Uint8Array, headerType: string, ext?: string): string {
    if (bytes.length >= 12) {
        if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
        if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
        if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
        if (
            bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
            bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
        ) {
            return "image/webp";
        }
        if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) return "video/mp4";
    }

    const cleanHeader = headerType.split(";")[0].trim().toLowerCase();
    if (cleanHeader && cleanHeader !== "application/octet-stream") {
        return cleanHeader;
    }

    if (ext === "gif") return "image/gif";
    if (ext === "webp") return "image/webp";
    if (ext === "png") return "image/png";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    if (ext === "mp4") return "video/mp4";
    return "image/png";
}

function computeTargetDimensions(srcW: number, srcH: number, targetSize: ResizeOption): { width: number; height: number } {
    if (!targetSize || targetSize <= 0) return { width: srcW, height: srcH };
    const maxDim = Math.max(srcW, srcH);
    if (maxDim <= targetSize) return { width: srcW, height: srcH };
    const scale = targetSize / maxDim;
    return {
        width: Math.max(1, Math.round(srcW * scale)),
        height: Math.max(1, Math.round(srcH * scale)),
    };
}

function applyAlphaThreshold(rgba: Uint8ClampedArray): boolean {
    let hasAlpha = false;
    for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i + 3] < 64) {
            rgba[i] = 0;
            rgba[i + 1] = 0;
            rgba[i + 2] = 0;
            rgba[i + 3] = 0;
            hasAlpha = true;
        } else {
            rgba[i + 3] = 255;
        }
    }
    return hasAlpha;
}

function downscaleRgba(
    srcRgba: Uint8ClampedArray,
    srcW: number,
    srcH: number,
    dstW: number,
    dstH: number
): Uint8ClampedArray {
    if (srcW === dstW && srcH === dstH) return new Uint8ClampedArray(srcRgba);
    const srcCanvas = document.createElement("canvas");
    srcCanvas.width = srcW;
    srcCanvas.height = srcH;
    const srcCtx = srcCanvas.getContext("2d")!;
    srcCtx.putImageData(new ImageData(new Uint8ClampedArray(srcRgba), srcW, srcH), 0, 0);

    const dstCanvas = document.createElement("canvas");
    dstCanvas.width = dstW;
    dstCanvas.height = dstH;
    const dstCtx = dstCanvas.getContext("2d")!;
    dstCtx.drawImage(srcCanvas, 0, 0, dstW, dstH);
    return dstCtx.getImageData(0, 0, dstW, dstH).data;
}

function encodeGifWithSizeGuardSync(
    frames: Array<{ rgba: Uint8ClampedArray; delayMs: number }>,
    width: number,
    height: number
): Blob {
    const strategies = [
        { step: 1, scale: 1 },
        { step: 2, scale: 1 },
        { step: 2, scale: 0.75 },
        { step: 3, scale: 0.6 },
    ];

    let bytes: Uint8Array = new Uint8Array(0);
    for (const s of strategies) {
        const w = Math.max(1, Math.round(width * s.scale));
        const h = Math.max(1, Math.round(height * s.scale));
        const gif = GIFEncoder();

        for (let i = 0; i < frames.length; i += s.step) {
            let delayMs = 0;
            for (let k = i; k < Math.min(frames.length, i + s.step); k++) {
                delayMs += frames[k].delayMs;
            }
            delayMs = Math.max(20, Math.round(delayMs));

            const rgba = downscaleRgba(frames[i].rgba, width, height, w, h);
            const hasAlpha = applyAlphaThreshold(rgba);
            const format = hasAlpha ? "rgba4444" : "rgb565";
            const palette = quantize(rgba, 256, { format, oneBitAlpha: hasAlpha });
            const index = applyPalette(rgba, palette, format);

            const transparentIndex = hasAlpha ? palette.findIndex(c => c[3] === 0) : -1;
            gif.writeFrame(index, w, h, {
                palette,
                delay: delayMs,
                repeat: i === 0 ? 0 : undefined,
                transparent: transparentIndex >= 0,
                transparentIndex: transparentIndex >= 0 ? transparentIndex : 0,
                dispose: transparentIndex >= 0 ? 2 : 0,
            });
        }

        gif.finish();
        bytes = gif.bytes();
        if (bytes.byteLength <= MAX_UPLOAD_BYTES) break;
    }

    return new Blob([new Uint8Array(bytes)], { type: "image/gif" });
}

async function decodeAndEncodeFallback(
    buffer: ArrayBuffer,
    mimeType: string,
    targetSize: ResizeOption
): Promise<Blob> {
    const ImageDecoderCtor = (globalThis as unknown as { ImageDecoder?: typeof ImageDecoder }).ImageDecoder;
    if (!ImageDecoderCtor) {
        return resizeStaticViaCanvas(new Blob([buffer], { type: mimeType }), targetSize);
    }

    const decoder = new ImageDecoderCtor({ data: buffer, type: mimeType });
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track ? track.frameCount : 1;

    const first = await decoder.decode({ frameIndex: 0 });
    const srcW = first.image.displayWidth || first.image.codedWidth;
    const srcH = first.image.displayHeight || first.image.codedHeight;
    const { width, height } = computeTargetDimensions(srcW, srcH, targetSize);

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
        first.image.close();
        decoder.close();
        throw new Error("Canvas 2D context unavailable");
    }

    if (frameCount <= 1) {
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(first.image, 0, 0, width, height);
        first.image.close();
        decoder.close();
        const pngBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        if (!pngBlob) throw new Error("PNG 인코딩 실패");
        return pngBlob;
    }

    const frames: Array<{ rgba: Uint8ClampedArray; delayMs: number }> = [];
    const firstDelayMs = Math.max(20, Math.round((first.image.duration || 100000) / 1000));
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(first.image, 0, 0, width, height);
    first.image.close();
    frames.push({ rgba: ctx.getImageData(0, 0, width, height).data, delayMs: firstDelayMs });

    for (let i = 1; i < frameCount; i++) {
        const result = await decoder.decode({ frameIndex: i });
        const delayMs = Math.max(20, Math.round((result.image.duration || 100000) / 1000));
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(result.image, 0, 0, width, height);
        result.image.close();
        frames.push({ rgba: ctx.getImageData(0, 0, width, height).data, delayMs });
    }

    decoder.close();
    return encodeGifWithSizeGuardSync(frames, width, height);
}

async function resizeStaticViaCanvas(blob: Blob, targetSize: ResizeOption): Promise<Blob> {
    if (blob.size === 0) {
        throw new Error("빈 이미지 데이터 (0 bytes)");
    }
    const imgUrl = URL.createObjectURL(blob);
    try {
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error(`이미지 디코딩 실패 (${blob.type}, ${blob.size}B)`));
            img.src = imgUrl;
        });

        const { width, height } = computeTargetDimensions(img.naturalWidth, img.naturalHeight, targetSize);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas 2D context unavailable");

        ctx.drawImage(img, 0, 0, width, height);
        const outBlob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        if (!outBlob) throw new Error("PNG 인코딩 실패");
        return outBlob;
    } finally {
        URL.revokeObjectURL(imgUrl);
    }
}

async function extractMp4FramesAndEncode(mp4Blob: Blob, targetSize: ResizeOption): Promise<Blob> {
    const videoUrl = URL.createObjectURL(mp4Blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = "anonymous";
    video.preload = "auto";
    video.src = videoUrl;

    try {
        await new Promise<void>((resolve, reject) => {
            const onReady = () => {
                cleanup();
                resolve();
            };
            const onErr = () => {
                cleanup();
                reject(new Error("MP4 비디오 로드 실패"));
            };
            const cleanup = () => {
                video.removeEventListener("loadeddata", onReady);
                video.removeEventListener("error", onErr);
            };
            video.addEventListener("loadeddata", onReady, { once: true });
            video.addEventListener("error", onErr, { once: true });
        });

        const srcW = video.videoWidth || 240;
        const srcH = video.videoHeight || 240;
        const { width, height } = computeTargetDimensions(srcW, srcH, targetSize);

        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
        const rawCount = Math.max(1, Math.round(duration * MP4_FPS));
        const frameCount = Math.min(MP4_MAX_FRAMES, rawCount);
        const stepSec = duration / frameCount;
        const delayMs = Math.max(20, Math.round(stepSec * 1000));

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("Canvas 2D context unavailable");

        const rawFrames: Array<{ rgba: Uint8ClampedArray; delayMs: number }> = [];

        for (let i = 0; i < frameCount; i++) {
            const targetTime = Math.min(duration - 0.001, i * stepSec);
            if (Math.abs(video.currentTime - targetTime) > 0.005) {
                await new Promise<void>((resolve) => {
                    const onSeeked = () => resolve();
                    video.addEventListener("seeked", onSeeked, { once: true });
                    video.currentTime = Math.max(0, targetTime);
                });
            }

            ctx.clearRect(0, 0, width, height);
            ctx.drawImage(video, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            rawFrames.push({ rgba: new Uint8ClampedArray(imageData.data), delayMs });
        }

        try {
            const transferBuffers = rawFrames.map(f => f.rgba.slice().buffer);
            const result = await runWorkerTask(
                {
                    type: "encodeFrames",
                    frames: transferBuffers,
                    delays: rawFrames.map(f => f.delayMs),
                    width,
                    height,
                },
                transferBuffers
            );
            return new Blob([result.buffer], { type: result.mimeType });
        } catch {
            return encodeGifWithSizeGuardSync(rawFrames, width, height);
        }
    } finally {
        video.pause();
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(videoUrl);
    }
}

export function getExtensionForMime(mimeType: string): "gif" | "jpg" | "webp" | "png" {
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/webp") return "webp";
    return "png";
}

export async function prepareEmoticonForUpload(
    bridge: NativeBridge,
    item: EmoticonItem,
    pack: EmoticonPack,
    resizeSize: ResizeOption,
    onPackUpdated?: (updated: EmoticonPack) => void
): Promise<{ blob: Blob; fileName: string; ext: "gif" | "jpg" | "webp" | "png" }> {
    const cacheKey = `send:${item.key}:${resizeSize}`;
    const cached = await getCachedBlob(cacheKey);
    if (cached && cached.size > 0 && cached.size <= MAX_UPLOAD_BYTES) {
        const ext = getExtensionForMime(cached.type);
        return {
            blob: cached,
            fileName: `${item.source}_${item.packId}_${item.id}.${ext}`,
            ext,
        };
    }

    const kind = item.origUrl ? "orig" : "media";
    const { blob: rawBlob, contentType } = await fetchMediaBlob(bridge, item, pack, kind, onPackUpdated);
    const rawBuffer = await rawBlob.arrayBuffer();
    const bytes = new Uint8Array(rawBuffer);
    const mimeType = detectMimeType(bytes, contentType, item.ext);

    let outBlob: Blob;

    if (mimeType === "video/mp4" || mimeType === "video/webm") {
        outBlob = await extractMp4FramesAndEncode(rawBlob, resizeSize);
    } else if (mimeType === "image/webp" || mimeType === "image/gif") {
        if (resizeSize === 0 && mimeType === "image/gif" && rawBlob.size <= MAX_UPLOAD_BYTES) {
            outBlob = new Blob([rawBuffer], { type: "image/gif" });
        } else {
            try {
                const workerBuf = rawBuffer.slice(0);
                const res = await runWorkerTask(
                    {
                        type: "decodeAndEncode",
                        buffer: workerBuf,
                        mimeType,
                        targetSize: resizeSize,
                    },
                    [workerBuf]
                );
                outBlob = new Blob([res.buffer], { type: res.mimeType });
            } catch {
                try {
                    outBlob = await decodeAndEncodeFallback(rawBuffer, mimeType, resizeSize);
                } catch {
                    outBlob = await resizeStaticViaCanvas(new Blob([rawBuffer], { type: mimeType }), resizeSize);
                }
            }
        }
    } else {
        if (resizeSize === 0 && rawBlob.size <= MAX_UPLOAD_BYTES && (mimeType === "image/png" || mimeType === "image/jpeg")) {
            outBlob = new Blob([rawBuffer], { type: mimeType });
        } else {
            outBlob = await resizeStaticViaCanvas(new Blob([rawBuffer], { type: mimeType }), resizeSize);
        }
    }

    await putCachedBlob(cacheKey, outBlob);
    const ext = getExtensionForMime(outBlob.type);
    return {
        blob: outBlob,
        fileName: `${item.source}_${item.packId}_${item.id}.${ext}`,
        ext,
    };
}
