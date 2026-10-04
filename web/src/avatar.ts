/** Letter-avatar colors: mid-tone, so white text reads well and they sit fine on light and dark surfaces. */
export const AVATAR_COLORS = ["#7a5af5", "#2f7d4f", "#c96442", "#b3428a", "#2b5fb8", "#0e7c86", "#8a5a2b"] as const;

/** Stable color for a slug (FNV-1a hash), so a board keeps its avatar color across reloads. */
export function avatarColor(slug: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) h = Math.imul(h ^ slug.charCodeAt(i), 0x01000193);
  return AVATAR_COLORS[(h >>> 0) % AVATAR_COLORS.length];
}

/** First letter of a name, uppercased, for the avatar. */
export const avatarLetter = (name: string) => (name.trim()[0] ?? "?").toUpperCase();
