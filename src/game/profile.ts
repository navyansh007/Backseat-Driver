import { cleanName } from '../shared/arena';

const KEY = 'tnd-name';

/** The player's username, kept on this browser. Arenas show it over your car and on the scoreboard. */
export const profile = {
  get name(): string | null {
    try { return cleanName(localStorage.getItem(KEY)); } catch { return null; }
  },
  /** Save a name; returns the tidied name, or null (and saves nothing) if it isn't usable. */
  setName(raw: string): string | null {
    const name = cleanName(raw);
    if (!name) return null;
    try { localStorage.setItem(KEY, name); } catch { /* storage unavailable */ }
    return name;
  },
};
