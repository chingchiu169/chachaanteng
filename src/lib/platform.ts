/** Platform detection for the webview — UA heuristic, no @tauri-apps/plugin-os dependency. */
export const isMac = (): boolean => /Mac|iPhone|iPod/.test(navigator.userAgent);
