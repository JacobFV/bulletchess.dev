import { useSyncExternalStore } from "react";

export type BoardTheme = "party" | "stone" | "brown" | "blue" | "green" | "grey" | "purple";
export interface Prefs {
  board: BoardTheme;
  sound: boolean;
  volume: number;
  premove: boolean;
  autoQueen: "always" | "premove" | "never";
  coords: boolean;
  animation: boolean;
  confirmResign: boolean;
  showDests: boolean;
  zen: boolean;
}

const DEFAULTS: Prefs = {
  board: "party",
  sound: true,
  volume: 0.7,
  premove: true,
  autoQueen: "premove",
  coords: true,
  animation: true,
  confirmResign: true,
  showDests: true,
  zen: false,
};

export const BOARD_THEMES: Record<BoardTheme, [string, string]> = {
  party: ["#fdf1d8", "#86a9dc"],
  stone: ["#e8e3d8", "#a39c8d"],
  brown: ["#f0d9b5", "#b58863"],
  blue: ["#dee3e6", "#8ca2ad"],
  green: ["#ffffdd", "#86a666"],
  grey: ["#d9d9d9", "#9a9a9a"],
  purple: ["#e6dcf0", "#9b80b8"],
};

const KEY = "bc:prefs";
let current: Prefs = read();
const listeners = new Set<() => void>();

function read(): Prefs {
  try {
    const saved = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
    return saved.board in BOARD_THEMES ? saved : { ...saved, board: DEFAULTS.board };
  } catch {
    return { ...DEFAULTS };
  }
}

export function getPrefs(): Prefs {
  return current;
}

export function setPrefs(patch: Partial<Prefs>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable */
  }
  listeners.forEach((l) => l());
}

export function usePrefs(): Prefs {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
