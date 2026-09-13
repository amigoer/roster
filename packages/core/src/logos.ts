import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
export const LOGOS: readonly Logo[] = [
  { id: "fox", name: "狐狸", background: "#B05943" },
  { id: "puppy", name: "小白狗", background: "#0F4FE7" },
  { id: "robot", name: "机器人", background: "#036DBE" },
  { id: "elephant", name: "大象", background: "#C4BFEE" },
  { id: "acorn", name: "橡果", background: "#73496C" },
  { id: "polar-bear", name: "北极熊", background: "#000000" },
  { id: "whale", name: "鲸鱼", background: "#31756C" },
  { id: "cactus", name: "仙人掌", background: "#BC5D4D" },
  { id: "white-bear", name: "白熊", background: "#000000" },
  { id: "rocket", name: "火箭", background: "#605493" },
  { id: "mushroom", name: "蘑菇", background: "#2D4057" },
  { id: "platypus", name: "鸭嘴兽", background: "#FEFEFE" },
  { id: "cowboy-cactus", name: "牛仔仙人掌", background: "#F5F2EC" },
  { id: "honey-bear", name: "小黄熊", background: "#5673D6" },
  { id: "whale-red", name: "小鲸鱼", background: "#BF5844" },
  { id: "lion", name: "狮子", background: "#B48730" },
  { id: "ninja", name: "忍者", background: "#F9F9D1" },
  { id: "pebble", name: "石头", background: "#2A573F" },
  { id: "snail", name: "蜗牛", background: "#346596" },
  { id: "cloud", name: "云朵", background: "#1F4C82" },
  { id: "frog", name: "青蛙", background: "#8FA68A" },
  { id: "manta", name: "蝠鲼", background: "#FC7953" },
  { id: "bear", name: "小熊", background: "#6E7867" },
  { id: "toaster", name: "吐司机", background: "#E6FAA8" },
  { id: "beluga", name: "白鲸", background: "#63778B" },
  { id: "teapot", name: "茶壶", background: "#393F3B" },
  { id: "cat", name: "白猫", background: "#000000" },
  { id: "ghost", name: "幽灵", background: "#6D4C6C" },
  { id: "jellyfish", name: "水母", background: "#363B35" },
  { id: "boo", name: "小幽灵", background: "#001B6E" },
  { id: "kitten", name: "小猫", background: "#000000" },
  { id: "sheep", name: "小绵羊", background: "#6F3CED" },
  { id: "rabbit", name: "兔子", background: "#764750" },
  { id: "axolotl", name: "六角恐龙", background: "#5E77D5" },
  { id: "dog", name: "小狗", background: "#000000" },
];

export const LOGO_IDS: readonly string[] = LOGOS.map((l) => l.id);

export const isLogo = (id: unknown): id is string => typeof id === "string" && LOGO_IDS.includes(id);
