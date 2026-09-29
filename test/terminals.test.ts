import { expect, test } from "bun:test";
import { Bus, type BusEvent } from "../src/server/events";
import { SessionCache } from "../src/server/session";
import { Store } from "../src/server/store";
import { TerminalWatcher } from "../src/server/terminals";
import { tempDir } from "./helpers";

test("TerminalWatcher flags linked tickets whose session is open and emits on change", async () => {
  const store = new Store(tempDir());
  const path = tempDir();
  store.saveProfile({ name: "P", slug: "p", path, baseBranch: "main", maxParallel: 1, createdAt: "" });
  const sid = "11111111-2222-3333-4444-555555555555";
  const t = store.createTicket("p", { title: "x", body: "", status: "review" });
  store.updateTicket("p", t.id, { sessionId: sid, workdir: path });
  const plain = store.createTicket("p", { title: "y", body: "", status: "review" });
  store.updateTicket("p", plain.id, { sessionId: "22222222-2222-3333-4444-555555555555" });

  let cmds = [`/Users/me/.local/bin/claude --resume ${sid}`, "claude --resume 22222222-2222-3333-4444-555555555555"];
  const bus = new Bus();
  const seen: BusEvent[] = [];
  bus.on((e) => seen.push(e));
  const w = new TerminalWatcher(store, bus, new SessionCache({ configDir: tempDir() }), async () => cmds);

  await w.poll();
  expect(w.isOpen("p", t.id)).toBe(true);
  expect(w.isOpen("p", plain.id)).toBe(false); // only linked tickets are tracked
  expect(seen.length).toBe(1);
  await w.poll();
  expect(seen.length).toBe(1);
  cmds = [];
  await w.poll();
  expect(w.isOpen("p", t.id)).toBe(false);
  expect(seen.length).toBe(2);
});
