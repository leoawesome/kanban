import { useCallback, useEffect, useRef, useState } from "react";
import { api, onReconnect, subscribe, type Huddle, type HuddleMessage } from "./api";
import { AVATAR_COLORS } from "./avatar";
import { mergeMessages, pickHuddle, upsertHuddle } from "./huddleText";

export { cardHuddleBadge, guestTickets, sortHuddles, type CardHuddleBadge } from "./huddleText";
export { handleInitials, mentionCandidates, mentionQuery, participantActivity } from "./huddleText";

/** Participants that count toward the cap (everyone but the user). */
export const members = (h: Huddle) => h.participants.filter((p) => p.kind !== "human");

/** What the huddle's agents have spent so far. */
export const huddleCost = (h: Huddle) => h.participants.reduce((s, p) => s + (p.costUsd ?? 0), 0);

/** Stable avatar color per handle; the coordinator gets the accent. */
export function handleColor(handle: string): string {
  if (handle === "main") return "var(--accent)";
  if (handle === "you") return "var(--muted)";
  let h = 0x811c9dc5;
  // Numbered copies (qa-1, qa-2) share their role's color.
  for (const c of handle.replace(/-\d+$/, "")) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193);
  return AVATAR_COLORS[(h >>> 0) % AVATAR_COLORS.length];
}

export interface HuddleState {
  huddle: Huddle | null;
  messages: HuddleMessage[];
  hasMore: boolean;
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
  loadEarlier: () => Promise<void>;
}

/** The ticket's huddle and its messages, kept live from huddle.updated / huddle.message events. */
export function useHuddle(slug: string, ticketId: string): HuddleState {
  const [huddle, setHuddle] = useState<Huddle | null>(null);
  const [messages, setMessages] = useState<HuddleMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef<string | null>(null);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const h = pickHuddle(await api.huddles(slug, ticketId), ticketId);
      if (mine !== seq.current) return;
      if (!h) {
        idRef.current = null;
        setHuddle(null);
        setMessages([]);
        setHasMore(false);
      } else {
        const r = await api.huddle(slug, h.id);
        if (mine !== seq.current) return;
        const switched = idRef.current !== h.id;
        idRef.current = h.id;
        setHuddle(r.huddle);
        setMessages((ms) => (switched ? r.messages : mergeMessages(ms, r.messages)));
        if (switched) setHasMore(r.hasMore);
      }
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message);
    } finally {
      if (mine === seq.current) setLoaded(true);
    }
  }, [slug, ticketId]);

  useEffect(() => {
    idRef.current = null;
    setHuddle(null);
    setMessages([]);
    setLoaded(false);
    reload();
  }, [reload]);

  useEffect(() => subscribe((e) => {
    if (e.type === "huddle.updated" && e.profile === slug && e.huddle.hostTicket === ticketId) {
      if (e.huddle.id === idRef.current) setHuddle(e.huddle);
      // A new huddle on this ticket (started here, from the chat card or another window).
      else if (e.huddle.status !== "closed") reload();
    } else if (e.type === "huddle.message" && e.profile === slug && e.huddleId === idRef.current) {
      setMessages((ms) => mergeMessages(ms, [e.message]));
    }
  }), [slug, ticketId, reload]);

  useEffect(() => onReconnect(() => void reload()), [reload]);

  const loadEarlier = useCallback(async () => {
    const id = idRef.current;
    const first = messages[0]?.seq;
    if (!id || first === undefined) return;
    const r = await api.huddle(slug, id, { before: first });
    if (idRef.current !== id) return;
    setMessages((ms) => mergeMessages(r.messages, ms));
    setHasMore(r.hasMore);
  }, [slug, messages]);

  return { huddle, messages, hasMore, loaded, error, reload, loadEarlier };
}

/** Every huddle on the board, kept live from huddle.updated events (card badges and the dock's Huddles list). */
export function useBoardHuddles(slug: string | null): Huddle[] {
  const [list, setList] = useState<Huddle[]>([]);
  const reload = useCallback(() => {
    if (!slug) return;
    api.boardHuddles(slug).then((hs) => setList(hs)).catch(() => {});
  }, [slug]);
  useEffect(() => {
    setList([]);
    reload();
  }, [reload]);
  useEffect(() => subscribe((e) => {
    if (e.type === "huddle.updated" && e.profile === slug) setList((hs) => upsertHuddle(hs, e.huddle));
  }), [slug]);
  useEffect(() => onReconnect(reload), [reload]);
  return list;
}
