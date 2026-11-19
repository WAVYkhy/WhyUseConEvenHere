import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export interface AutoUpdateOptions {
    silent?: boolean;
    onStatus?: (message: string, variant?: "info" | "success" | "error") => void;
}

/**
 * Checks for an application update and automatically downloads, installs,
 * and relaunches when a newer version is available.
 * Returns true if an update was found and installation started.
 */
export async function checkAndAutoInstallUpdate(options: AutoUpdateOptions = {}): Promise<boolean> {
    const { silent = true, onStatus } = options;
    try {
        const update = await check();
        if (!update) {
            if (!silent) {
                onStatus?.("현재 최신 버전입니다.", "info");
            }
            return false;
        }

        onStatus?.(`새 버전(v${update.version})을 다운로드하고 있습니다...`, "info");
        await update.downloadAndInstall();
        onStatus?.("업데이트 설치 완료. 앱을 재시작합니다.", "success");
        await relaunch();
        return true;
    } catch (err) {
        if (!silent) {
            const message = err instanceof Error ? err.message : String(err);
            onStatus?.(`업데이트 확인 실패: ${message}`, "error");
        }
        return false;
    }
}
