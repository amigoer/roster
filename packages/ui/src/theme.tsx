import { useEffect, useState } from "react";

export type Theme = "light" | "dark" | "system";
const KEY = "roster.theme";
export const THEMES: Theme[] = ["system", "light", "dark"];

function apply(theme: Theme): void {
  const dark =
    theme === "dark" ||
    (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
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

  useEffect(() => {
    apply(theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // ignore
    }
    if (theme !== "system") return;
    // follow the OS while on system, without a reload
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  return { theme, setTheme };
}
