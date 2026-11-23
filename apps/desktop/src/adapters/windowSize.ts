import { currentMonitor, getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";

import { loadWindowSize, saveWindowSize } from "./tauriStorage";

export const MIN_WINDOW_WIDTH = 340;
export const MIN_WINDOW_HEIGHT = 320;
const SAVE_DEBOUNCE_MS = 400;
const WORK_AREA_MARGIN = 8;

function clampDimension(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(Math.round(value), Math.round(max)));
}

/**
 * Applies the persisted window size on startup so the popup keeps the size the
 * user dragged it to in the previous session. Sizes are stored in logical pixels
 * and clamped to the work area of the monitor the window currently lives on.
 */
export async function applySavedWindowSize(): Promise<void> {
    const saved = await loadWindowSize();
    if (!saved) return;

    const win = getCurrentWindow();
    let maxWidth = Number.POSITIVE_INFINITY;
    let maxHeight = Number.POSITIVE_INFINITY;

    try {
        const monitor = await currentMonitor();
        if (monitor) {
            maxWidth = monitor.size.width / monitor.scaleFactor - WORK_AREA_MARGIN;
            maxHeight = monitor.size.height / monitor.scaleFactor - WORK_AREA_MARGIN;
        }
    } catch {
        // Monitor lookup is best-effort; fall back to unclamped size.
    }

    const width = clampDimension(saved.width, MIN_WINDOW_WIDTH, Math.max(MIN_WINDOW_WIDTH, maxWidth));
    const height = clampDimension(saved.height, MIN_WINDOW_HEIGHT, Math.max(MIN_WINDOW_HEIGHT, maxHeight));
    await win.setSize(new LogicalSize(width, height));
}

/** Starts a native resize drag from the bottom-right corner grip. */
export async function beginResizeDrag(): Promise<void> {
    await getCurrentWindow().startResizeDragging("SouthEast");
}

/**
 * Persists the window size whenever the user finishes dragging the resize handle.
 * Returns an unsubscribe function.
 */
export function startWindowSizeTracking(): () => void {
    const win = getCurrentWindow();
    let timer: number | null = null;
    let disposed = false;

    const persist = async () => {
        try {
            const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
            if (disposed) return;
            const logical = size.toLogical(scale);
            await saveWindowSize({
                width: Math.round(logical.width),
                height: Math.round(logical.height),
            });
        } catch {
            // Ignore persistence failures; the size stays applied for this session.
        }
    };

    const unlistenPromise = win.onResized(() => {
        if (timer !== null) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            timer = null;
            void persist();
        }, SAVE_DEBOUNCE_MS);
    });

    return () => {
        disposed = true;
        if (timer !== null) {
            window.clearTimeout(timer);
            timer = null;
        }
        void unlistenPromise.then(unlisten => unlisten());
    };
}
