import type { CSSProperties } from "react";

/** Electron's hidden title bar: chrome drags the window, and anything clickable inside it has to opt out. */
export const DRAG = { WebkitAppRegion: "drag" } as CSSProperties;
export const NO_DRAG = { WebkitAppRegion: "no-drag" } as CSSProperties;
