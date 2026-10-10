import { beforeEach, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { checkPr } from "../src/server/prpoller";
import type { SessionSummary } from "../src/server/session";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let id: string;
let summary: Partial<SessionSummary> | null;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  summary = null;
  const sessionSummary = () => summary && ({
    title: null, lastMessage: null, artifacts: [], updatedAt: "", openQuestions: 0, pendingProposal: null, pendingNewTickets: [], pendingTeammates: [], ...summary,
  });
  board = new Board(store, new Bus(), { claudeBin: "/bin/false", sessionSummary });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  id = store.createTicket("p", { title: "x", body: "", status: "review" }).id;
  store.updateTicket("p", id, { prUrl: "https://github.com/x/y/pull/1", sessionId: "s1" });
});

test("merged PR moves ticket to done", async () => {
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
});

test("closed PR comments once and stays in review", async () => {
  await checkPr(board, store, "p", id, async () => "CLOSED");
  await checkPr(board, store, "p", id, async () => "CLOSED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  const c = store.listComments("p", id).filter((c) => c.text === "PR closed without merge.");
  expect(c.length).toBe(1);
});

test("open PR leaves ticket unchanged", async () => {
  await checkPr(board, store, "p", id, async () => "OPEN");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(store.listComments("p", id).length).toBe(0);
});

test("merged PR does not touch ticket the user moved during gh call", async () => {
  await checkPr(board, store, "p", id, async () => {
    store.updateTicket("p", id, { status: "backlog" });
    return "MERGED";
  });
  expect(store.getTicket("p", id)!.status).toBe("backlog");
});

const merged = () => store.listComments("p", id).filter((c) => c.text === "PR merged.").length;

test("merged PR keeps a ticket with uncreated proposed tickets in review, then moves it once they exist", async () => {
  summary = { pendingNewTickets: [{ title: "Fix logout", description: "" }, { title: "Fix keyboard", description: "" }] };
  for (let i = 0; i < 3; i++) await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  expect(merged()).toBe(1);

  store.createTicket("p", { title: "Fix logout", body: "", status: "backlog", parentId: id });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");

  store.createTicket("p", { title: "Fix keyboard", body: "", status: "backlog", parentId: id });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
  expect(merged()).toBe(1);
});

test("merged PR keeps a ticket with open questions in review", async () => {
  summary = { openQuestions: 2 };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
  summary = { openQuestions: 0 };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("done");
  expect(merged()).toBe(1);
});

test("merged PR keeps a needs_input ticket in review", async () => {
  store.updateTicket("p", id, { outcome: "needs_input" });
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
});

test("merged PR keeps a ticket with an unapplied proposal in review", async () => {
  summary = { pendingProposal: { title: "Better title", description: "" } };
  await checkPr(board, store, "p", id, async () => "MERGED");
  expect(store.getTicket("p", id)!.status).toBe("review");
});

test("injected wait check decides", async () => {
  await checkPr(board, store, "p", id, async () => "MERGED", () => true);
  expect(store.getTicket("p", id)!.status).toBe("review");
  await checkPr(board, store, "p", id, async () => "MERGED", () => false);
  expect(store.getTicket("p", id)!.status).toBe("done");
});
