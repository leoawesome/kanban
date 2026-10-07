import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Bus } from "./events";
import { atomicWrite, type Store } from "./store";
import { newId, nowIso } from "./util";

/** Reusable prompt text, inserted by typing `@name` in a composer. scope: "global" or a board (profile slug). */
export interface Snippet {
  id: string;
  name: string;
  text: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export type SnippetInput = Pick<Snippet, "name" | "text" | "scope">;

export class SnippetError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME = 40;
const MAX_TEXT = 20_000;

/** All snippets live in one file, `<root>/snippets.json`; board ones carry their profile slug as scope. */
export class Snippets {
  constructor(private store: Store, private bus: Bus) {}

  private get file() {
    return join(this.store.root, "snippets.json");
  }

  private readAll(): Snippet[] {
    if (!existsSync(this.file)) return [];
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private writeAll(list: Snippet[]) {
    atomicWrite(this.file, JSON.stringify(list, null, 2) + "\n");
    this.bus.emit({ type: "snippets.updated" });
  }

  /** Global snippets plus the board's own (all of them without a board), sorted by name. */
  list(profile?: string): Snippet[] {
    return this.readAll()
      .filter((s) => !profile || s.scope === "global" || s.scope === profile)
      .sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
  }

  private validate(input: Partial<SnippetInput>, list: Snippet[], selfId?: string): SnippetInput {
    const name = String(input.name ?? "").trim().replace(/^@/, "");
    const text = String(input.text ?? "");
    const scope = String(input.scope ?? "global");
    if (!name) throw new SnippetError(400, "name is required");
    if (name.length > MAX_NAME) throw new SnippetError(400, `name is too long (max ${MAX_NAME} characters)`);
    if (!NAME_RE.test(name)) throw new SnippetError(400, "name may only use lowercase letters, digits and dashes");
    if (!text.trim()) throw new SnippetError(400, "text is required");
    if (text.length > MAX_TEXT) throw new SnippetError(400, `text is too long (max ${MAX_TEXT} characters)`);
    if (scope !== "global" && !this.store.getProfile(scope)) throw new SnippetError(400, `board ${scope} not found`);
    if (list.some((s) => s.id !== selfId && s.scope === scope && s.name === name)) {
      throw new SnippetError(409, `@${name} already exists ${scope === "global" ? "on all boards" : "on this board"}`);
    }
    return { name, text, scope };
  }

  create(input: Partial<SnippetInput>): Snippet {
    const list = this.readAll();
    const at = nowIso();
    const s: Snippet = { id: newId(), ...this.validate(input, list), createdAt: at, updatedAt: at };
    this.writeAll([...list, s]);
    return s;
  }

  update(id: string, patch: Partial<SnippetInput>): Snippet {
    const list = this.readAll();
    const i = list.findIndex((s) => s.id === id);
    if (i < 0) throw new SnippetError(404, "snippet not found");
    const next: Snippet = { ...list[i], ...this.validate({ ...list[i], ...patch }, list, id), updatedAt: nowIso() };
    list[i] = next;
    this.writeAll(list);
    return next;
  }

  remove(id: string): void {
    const list = this.readAll();
    if (!list.some((s) => s.id === id)) throw new SnippetError(404, "snippet not found");
    this.writeAll(list.filter((s) => s.id !== id));
  }

  /** A board was deleted: its own snippets go with it. */
  dropScope(profile: string): void {
    const list = this.readAll();
    if (list.some((s) => s.scope === profile)) this.writeAll(list.filter((s) => s.scope !== profile));
  }
}
