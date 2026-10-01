import { expect, test } from "bun:test";
import { MAX_AGE, draftKey, forget, formKey, loadSaved, prune, save, type Store } from "../web/src/drafts";

function memStore(init: Record<string, string> = {}): Store & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
    key: (i) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
}

test("keys are scoped by profile, ticket and block", () => {
  expect(draftKey("p", "t1")).not.toBe(draftKey("p", "t2"));
  expect(draftKey("a", "t1")).not.toBe(draftKey("b", "t1"));
  expect(formKey("p", "t1", "u1")).not.toBe(formKey("p", "t1", "u2"));
});

test("save, load and forget round-trip", () => {
  const s = memStore();
  save(s, "ckanban.draft.p.t", "half a sentence");
  expect(loadSaved<string>(s, "ckanban.draft.p.t")).toBe("half a sentence");
  save(s, "ckanban.qform.p.t.u", { step: 1, note: "x" });
  expect(loadSaved<object>(s, "ckanban.qform.p.t.u")).toEqual({ step: 1, note: "x" });
  forget(s, "ckanban.draft.p.t");
  expect(loadSaved(s, "ckanban.draft.p.t")).toBeNull();
});

test("corrupt or missing storage falls back to null", () => {
  const s = memStore({ a: "{not json", b: "\"plain\"", c: "null" });
  expect(loadSaved(s, "a")).toBeNull();
  expect(loadSaved(s, "b")).toBeNull();
  expect(loadSaved(s, "c")).toBeNull();
  expect(loadSaved(null, "a")).toBeNull();
  const throwing: Store = { ...s, getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
  expect(loadSaved(throwing, "a")).toBeNull();
  expect(() => save(throwing, "a", 1)).not.toThrow();
  expect(() => save(null, "a", 1)).not.toThrow();
});

test("prune drops old and unreadable drafts, keeps fresh ones and other keys", () => {
  const now = 1_000_000_000_000;
  const s = memStore({ "ckanban.dock.tab": "files", "ckanban.draft.p.bad": "{oops" });
  save(s, "ckanban.draft.p.old", "old", now - MAX_AGE - 1);
  save(s, "ckanban.qform.p.t.old", {}, now - MAX_AGE - 1);
  save(s, "ckanban.draft.p.new", "new", now - 1000);
  prune(s, now);
  expect([...s.data.keys()].sort()).toEqual(["ckanban.dock.tab", "ckanban.draft.p.new"]);
});
