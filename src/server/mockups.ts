import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Planning runs are read-only (plan mode), so Claude can't write mockup files itself. It puts each one in a
 * <ckanban-mockup name="..."> block in its reply instead; the board saves it to the ticket's outputs folder,
 * where the Outputs tab previews it and offers Approve.
 */

/** Where mockups live, relative to the outputs folder. */
export const MOCKUPS_DIR = "mockups";
export const APPROVED_NAME = "approved.html";
export const APPROVED_MOCKUP = `${MOCKUPS_DIR}/${APPROVED_NAME}`;

const BLOCK_RE = /<ckanban-mockup\s+name="([^"]*)"\s*>([\s\S]*?)<\/ckanban-mockup>/g;
/** A block still being written (no closing tag yet), so the chat can hide it while it streams. */
export const OPEN_MOCKUP_TAG = "<ckanban-mockup";

/** A safe file name for a mockup ("a-compact.html"), or null. approved.html is the board's own. */
export function mockupName(name: string): string | null {
  const n = name.trim();
  if (!/^[\w][\w.-]{0,80}\.html?$/i.test(n) || n.includes("..")) return null;
  return n.toLowerCase() === APPROVED_NAME ? null : n;
}

export interface Mockup {
  name: string;
  html: string;
}

/** The mockup blocks in a reply (valid names only; a ``` fence around the HTML is dropped). */
export function extractMockups(text: string): Mockup[] {
  const out: Mockup[] = [];
  for (const m of text.matchAll(BLOCK_RE)) {
    const name = mockupName(m[1]);
    const html = m[2].trim().replace(/^```(?:html)?\s*\n/, "").replace(/\n?```$/, "").trim();
    if (name && html) out.push({ name, html });
  }
  return out;
}

/** The reply without its mockup blocks, plus the names of the mockups they carried. */
export function stripMockups(text: string): { text: string; names: string[] } {
  const names = extractMockups(text).map((m) => m.name);
  let out = text.replace(BLOCK_RE, "");
  // An unfinished block (the reply was cut off) is HTML noise in the chat; drop it too.
  const open = out.indexOf(OPEN_MOCKUP_TAG);
  if (open >= 0) out = out.slice(0, open);
  return { text: out, names };
}

/** Save the reply's mockups to <outputDir>/mockups; returns the names written. */
export function saveMockups(outputDir: string, text: string): string[] {
  const mockups = extractMockups(text);
  if (!mockups.length) return [];
  const dir = join(outputDir, MOCKUPS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const m of mockups) writeFileSync(join(dir, m.name), m.html.endsWith("\n") ? m.html : `${m.html}\n`);
  return mockups.map((m) => m.name);
}

/** Path (relative to outputs) of an existing mockup the user may approve, or null. */
export function approvableMockup(name: string): string | null {
  if (!name.startsWith(`${MOCKUPS_DIR}/`)) return null;
  const file = name.slice(MOCKUPS_DIR.length + 1);
  return file.toLowerCase() === APPROVED_NAME || mockupName(file) ? `${MOCKUPS_DIR}/${file}` : null;
}

/** Copy an approved mockup (absolute path, already validated) to mockups/approved.html. */
export function approveMockup(outputDir: string, file: string): string {
  const target = join(outputDir, APPROVED_MOCKUP);
  if (file !== target) copyFileSync(file, target);
  return target;
}

/** The chat message the board sends when the user approves a mockup. */
export function approvedMessage(name: string): string {
  return `Approved mockup: ${name} (saved as ${APPROVED_MOCKUP}). Please propose the final ticket with it as the target design.`;
}

