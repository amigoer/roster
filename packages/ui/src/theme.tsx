import { useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "roster.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

let easing: ReturnType<typeof setTimeout> | undefined;

/** ease: every colour crosses over rather than flipping; not on the first paint, where there is nothing to cross from */
function apply(theme: Theme, ease: boolean): void {
  const root = document.documentElement;
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  if (root.classList.contains("dark") === dark) return;
  if (ease) {
    root.classList.add("theming");
    clearTimeout(easing);
    easing = setTimeout(() => root.classList.remove("theming"), 300);
  }
  root.classList.toggle("dark", dark);
}

/** The dark tokens have been in the stylesheet all along; this is the switch. Call it once, at the root: each call keeps its own copy. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark" || saved === "system") return saved;
    } catch {
      // a theme that cannot be remembered still applies for this session
    }
    return "system";
  });

  // index.html already set the class from storage before React ran, so the first apply changes nothing
  const first = useRef(true);
  useEffect(() => {
    apply(theme, !first.current);
    first.current = false;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore
    }
    if (theme !== "system") return;
    // follow the OS while on system, without a reload
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system", true);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
