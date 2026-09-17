/** What the Electron shell exposes to the page through its preload script; absent in a plain browser. */
export interface DesktopBridge {
  /** a native folder chooser; null when it was cancelled */
  pickDirectory(defaultPath?: string): Promise<string | null>;
  /** opens the folder in the system's file manager */
  revealDirectory(path: string): Promise<boolean>;
}

declare global {
  interface Window {
    roster?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | undefined => window.roster;
