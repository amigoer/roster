import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "./i18n/index.js";

/** Next to the package, so it resolves the same from src and from dist. */
export const LOGOS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../assets/logos");

export interface Logo {
  id: string;
  name: string;
  /** the logo's own solid background, shown while the image loads */
  background: string;
}

/**
 * Every bot wears one of these, so the roster reads as one family. Order is
 * the showcase wall's, and it is also the order new bots are handed logos in.
 */
const SET = [
  { id: "fox", background: "#B05943" },
  { id: "puppy", background: "#0F4FE7" },
  { id: "robot", background: "#036DBE" },
  { id: "elephant", background: "#C4BFEE" },
  { id: "acorn", background: "#73496C" },
  { id: "polar-bear", background: "#000000" },
  { id: "whale", background: "#31756C" },
  { id: "cactus", background: "#BC5D4D" },
  { id: "white-bear", background: "#000000" },
  { id: "rocket", background: "#605493" },
  { id: "mushroom", background: "#2D4057" },
  { id: "platypus", background: "#FEFEFE" },
  { id: "cowboy-cactus", background: "#F5F2EC" },
  { id: "honey-bear", background: "#5673D6" },
  { id: "whale-red", background: "#BF5844" },
  { id: "lion", background: "#B48730" },
  { id: "ninja", background: "#F9F9D1" },
  { id: "pebble", background: "#2A573F" },
  { id: "snail", background: "#346596" },
  { id: "cloud", background: "#1F4C82" },
  { id: "frog", background: "#8FA68A" },
  { id: "manta", background: "#FC7953" },
  { id: "bear", background: "#6E7867" },
  { id: "toaster", background: "#E6FAA8" },
  { id: "beluga", background: "#63778B" },
  { id: "teapot", background: "#393F3B" },
  { id: "cat", background: "#000000" },
  { id: "ghost", background: "#6D4C6C" },
  { id: "jellyfish", background: "#363B35" },
  { id: "boo", background: "#001B6E" },
  { id: "kitten", background: "#000000" },
  { id: "sheep", background: "#6F3CED" },
  { id: "rabbit", background: "#764750" },
  { id: "axolotl", background: "#5E77D5" },
  { id: "dog", background: "#000000" },
] as const;

/** The set, named in the current language. */
export const logos = (): Logo[] => SET.map(({ id, background }) => ({ id, name: t(`logo.${id}`), background }));

export const LOGO_IDS: readonly string[] = SET.map((l) => l.id);

export const isLogo = (id: unknown): id is string => typeof id === "string" && LOGO_IDS.includes(id);
