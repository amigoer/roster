import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

/** The tile behind your initial when there is no photo. White reads on every one, in light and dark. */
export const COLORS = [
  { id: "blue", hex: "#3370ff" },
  { id: "purple", hex: "#7f3bf5" },
  { id: "pink", hex: "#d9418d" },
  { id: "red", hex: "#e5484d" },
  { id: "orange", hex: "#e8710a" },
  { id: "green", hex: "#2ea121" },
  { id: "teal", hex: "#0e9aa7" },
] as const;

export type ColorId = (typeof COLORS)[number]["id"];

export const colorOf = (id: ColorId): string => COLORS.find((c) => c.id === id)?.hex ?? COLORS[0].hex;

/**
 * You, as Roster shows you. Only this window keeps it for now; a profile synced
 * across devices carries the same fields, so moving it means changing MeProvider
 * and nothing that reads it.
 */
export type Profile = {
  name: string;
  title: string;
  bio: string;
  email: string;
  location: string;
  /** null keeps the plain grey tile that stood for you before there was a profile */
  color: ColorId | null;
  /** a square data URL, cropped and scaled down before it is kept */
  photo: string | null;
  /** 0 until the first save; what a sync would compare */
  updatedAt: number;
};

const BLANK: Profile = { name: "", title: "", bio: "", email: "", location: "", color: null, photo: null, updatedAt: 0 };

const KEY = "roster.profile";

function read(): Profile {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Record<string, unknown> | null;
    if (saved && typeof saved === "object") {
      const text = (v: unknown) => (typeof v === "string" ? v : "");
      const { photo, updatedAt } = saved;
      return {
        name: text(saved.name),
        title: text(saved.title),
        bio: text(saved.bio),
        email: text(saved.email),
        location: text(saved.location),
        color: COLORS.find((c) => c.id === saved.color)?.id ?? null,
        photo: typeof photo === "string" && photo.startsWith("data:image/") ? photo : null,
        updatedAt: typeof updatedAt === "number" ? updatedAt : 0,
      };
    }
  } catch {
    // a profile that cannot be read starts blank
  }
  return BLANK;
}

export interface Me {
  profile: Profile;
  save(next: Profile): void;
}

const MeContext = createContext<Me | null>(null);

export function MeProvider({ children }: { children: ReactNode }) {
  const [profile, setProfile] = useState(read);
  const save = useCallback((next: Profile) => {
    const stamped = { ...next, updatedAt: Date.now() };
    setProfile(stamped);
    try {
      localStorage.setItem(KEY, JSON.stringify(stamped));
    } catch {
      // a profile that cannot be remembered still shows until the window closes
    }
  }, []);
  const value = useMemo<Me>(() => ({ profile, save }), [profile, save]);
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error("useMe is only for components under MeProvider");
  return me;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The first letter, character or emoji of a name; a leading @ or bracket is skipped. */
export function initialOf(name: string): string {
  for (const { segment } of graphemes.segment(name)) {
    if (/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(segment)) return segment.toLocaleUpperCase();
  }
  return "";
}

/** Past the largest avatar at 2x, so a Retina screen shows it sharp. */
const PHOTO_EDGE = 256;

/** The middle square of a picture, scaled down to keep in localStorage; null when it cannot be decoded. */
export async function photoFrom(file: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;
  const side = Math.min(bitmap.width, bitmap.height);
  const edge = Math.min(PHOTO_EDGE, side);
  const ctx = edge > 0 ? document.createElement("canvas").getContext("2d") : null;
  if (!ctx) {
    bitmap.close();
    return null;
  }
  ctx.canvas.width = edge;
  ctx.canvas.height = edge;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, edge, edge);
  bitmap.close();
  return ctx.canvas.toDataURL("image/webp", 0.9);
}
