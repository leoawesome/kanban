// Ticket-to-ticket questions: one ticket's Claude asks another's (ask_ticket) and waits for its reply (reply_ticket).
// The question goes into the target's real session (steering its run, or starting a quiet reply run), so the target
// can answer or ask back and both tickets' chats show the exchange. Kept per board in questions.json.
import { ConflictError, type Board } from "./board";
import { askPrompt, lateReplyComment, lateReplyPrompt } from "./prompts";
import type { Store } from "./store";
import type { Ticket, TicketQuestion } from "./types";
import { newId, nowIso } from "./util";

export class QuestionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A reply this soon after the asker's wait ended still goes to its call (it may be polling one last time). */
const GRACE_MS = 30_000;
/** Settled questions are dropped from questions.json after this long. */
const KEEP_MS = 7 * 24 * 3600_000;
export const MAX_WAIT_MS = 30 * 60_000;

export class Questions {
  constructor(private store: Store, private board: Board, private now: () => number = Date.now) {}

  private all(slug: string): TicketQuestion[] {
    return this.store.listQuestions(slug);
  }

  private save(slug: string, qs: TicketQuestion[]) {
    const cutoff = this.now() - KEEP_MS;
    this.store.saveQuestions(slug, qs.filter((q) => !q.delivered || Date.parse(q.repliedAt ?? q.askedAt) > cutoff));
  }

  private update(slug: string, q: TicketQuestion) {
    this.save(slug, this.all(slug).map((x) => (x.id === q.id ? q : x)));
  }

  private find(slug: string, qid: string): TicketQuestion {
    const q = this.all(slug).find((x) => x.id === qid);
    if (!q) throw new QuestionError(404, `unknown question id ${qid}`);
    return q;
  }

  private ticket(slug: string, id: string, status = 404): Ticket {
    const t = this.store.getTicket(slug, id);
    if (!t) throw new QuestionError(status, `ticket ${id} not found`);
    return t;
  }

  /** Ticket `fromId`'s Claude asks ticket `toId`'s Claude; the asker then polls for the reply. */
  async ask(slug: string, fromId: string, toId: string, text: string, waitMs: number): Promise<TicketQuestion & { toTitle: string }> {
    const from = this.ticket(slug, fromId, 403);
    if (!text.trim()) throw new QuestionError(400, "question is required");
    if (toId === fromId) throw new QuestionError(400, "that is your own ticket; ask another ticket's Claude");
    const to = this.ticket(slug, toId);
    if (to.error?.startsWith("corrupt")) throw new QuestionError(409, `ticket ${toId} file is corrupt`);
    // A ticket in its first run has a session already (queued messages wait for it to start).
    const hasSession = this.board.isRunning(slug, toId) || (!!to.sessionId && (!!to.sessionStarted || to.runCount > 0 || !!to.workdir));
    if (!hasSession) {
      throw new QuestionError(409, `ticket ${toId} has no Claude session yet (Claude never worked on it), so there is nobody to ask; read it with get_ticket instead`);
    }
    const now = this.now();
    // Both waiting on each other would just time out: the other side can't read messages while its call waits.
    const theirs = this.all(slug).find((q) => q.from === toId && q.to === fromId && q.waiting && q.reply === null && Date.parse(q.waitUntil) > now);
    if (theirs) {
      throw new QuestionError(409, `ticket ${toId}'s Claude is itself waiting for your reply to question ${theirs.id} ("${theirs.text.slice(0, 120)}"); answer it with reply_ticket first`);
    }
    const wait = Math.max(1000, Math.min(MAX_WAIT_MS, Math.round(waitMs) || MAX_WAIT_MS));
    const q: TicketQuestion = {
      id: `q_${newId()}`, from: fromId, to: toId, text: text.trim(), askedAt: nowIso(), waitUntil: new Date(now + wait).toISOString(),
      waiting: true, reply: null, repliedAt: null, delivered: null,
    };
    this.save(slug, [...this.all(slug), q]);
    try {
      await this.board.chat(slug, toId, askPrompt(from, q), { peer: true });
    } catch (e) {
      this.save(slug, this.all(slug).filter((x) => x.id !== q.id));
      if (e instanceof ConflictError) throw new QuestionError(409, `ticket ${toId}: ${e.message}`);
      throw new QuestionError(400, (e as Error).message);
    }
    return { ...q, toTitle: to.title };
  }

  /** The asker's call checks for the reply; `final`: it stops waiting, so a later reply is delivered another way. */
  poll(slug: string, qid: string, fromId: string, final = false): { reply: string | null } {
    const q = this.find(slug, qid);
    if (q.from !== fromId) throw new QuestionError(403, `question ${qid} was asked by ticket ${q.from}, not ${fromId}`);
    if (q.reply !== null && (q.delivered === null || q.delivered === "call")) {
      if (q.delivered === null || q.waiting) this.update(slug, { ...q, delivered: "call", waiting: false });
      return { reply: q.reply };
    }
    if (final && q.waiting) this.update(slug, { ...q, waiting: false });
    return { reply: null };
  }

  /**
   * Ticket `byId`'s Claude replies (null: from outside a board run, e.g. a linked terminal session).
   * Goes to the asker's waiting call, else into its run if it is working, else into a comment for its next run.
   */
  async reply(slug: string, qid: string, byId: string | null, text: string): Promise<{ delivered: "call" | "steer" | "comment" | "gone"; from: string }> {
    const q = this.find(slug, qid);
    if (byId && byId !== q.to) throw new QuestionError(403, `question ${qid} was sent to ticket ${q.to}, not to ${byId}`);
    if (q.reply !== null) throw new QuestionError(409, `question ${qid} already has a reply`);
    if (!text.trim()) throw new QuestionError(400, "text is required");
    const answered: TicketQuestion = { ...q, reply: text.trim(), repliedAt: nowIso() };
    if (q.waiting && this.now() <= Date.parse(q.waitUntil) + GRACE_MS) {
      this.update(slug, answered);
      return { delivered: "call", from: q.from };
    }
    const asker = this.store.getTicket(slug, q.from);
    const to = this.store.getTicket(slug, q.to) ?? ({ id: q.to, title: q.to } as Ticket);
    let delivered: "steer" | "comment" | "gone" = "gone";
    if (asker) {
      if (this.board.isRunning(slug, asker.id)) {
        try {
          await this.board.chat(slug, asker.id, lateReplyPrompt(to, answered), { peer: true });
          delivered = "steer";
        } catch {}
      }
      if (delivered === "gone") {
        this.board.addComment(slug, asker.id, lateReplyComment(to, answered));
        delivered = "comment";
      }
    }
    this.update(slug, { ...answered, waiting: false, delivered: delivered === "gone" ? "comment" : delivered });
    return { delivered, from: q.from };
  }
}
