/** Links leave the board in a new tab; only same-page hash links (e.g. `#/board/ticket`) stay in this one. */
export const opensNewTab = (href: string | null): boolean => !!href && !href.startsWith("#");
