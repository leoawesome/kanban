import { beforeEach, expect, test } from "bun:test";
import { Board } from "../src/server/board";
import { Bus } from "../src/server/events";
import { checkPr } from "../src/server/prpoller";
import { Store } from "../src/server/store";
import { tempDir } from "./helpers";

let store: Store;
let board: Board;
let id: string;

beforeEach(() => {
  store = new Store(tempDir("ck-home-"));
  board = new Board(store, new Bus(), { claudeBin: "/bin/false" });
  store.saveProfile({ name: "P", slug: "p", path: tempDir(), baseBranch: "main", maxParallel: 1, createdAt: "" });
  id = store.createTicket("p", { title: "x", body: "", status: "review" }).id;
  store.updateTicket("p", id, { prUrl: "https://github.com/x/y/pull/1" });
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
