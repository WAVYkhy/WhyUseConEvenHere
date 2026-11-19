declare module "gifenc" {
    export type PaletteColor = number[];
    export interface QuantizeOptions {
        format?: "rgb565" | "rgb444" | "rgba4444";
        oneBitAlpha?: boolean | number;
        clearAlpha?: boolean;
        clearAlphaColor?: number;
        clearAlphaThreshold?: number;
        useSqrt?: boolean;
    }
    export interface WriteFrameOptions {
        palette?: PaletteColor[] | null;
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        colorDepth?: number;
        first?: boolean;
    }
    export function quantize(
        rgba: Uint8Array | Uint8ClampedArray,
        maxColors: number,
        options?: QuantizeOptions
    ): PaletteColor[];
    export function applyPalette(
        rgba: Uint8Array | Uint8ClampedArray,
        palette: PaletteColor[],
        format?: "rgb565" | "rgb444" | "rgba4444"
    ): Uint8Array;
    export function GIFEncoder(): {
        writeFrame(index: Uint8Array, width: number, height: number, options?: WriteFrameOptions): void;
        finish(): void;
        bytes(): Uint8Array;
        bytesView(): Uint8Array;
        reset(): void;
    };
}
