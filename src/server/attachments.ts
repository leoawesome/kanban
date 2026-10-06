import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Images pasted into descriptions and chat. Stored flat under <data root>/attachments/. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};
const TYPE_OF_EXT = Object.fromEntries(Object.entries(IMAGE_TYPES).map(([t, e]) => [e, t]));

/** Only names we generate: 32 hex chars + a known extension. Anything else (../, subdirs) is rejected. */
const NAME_RE = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;
/** An attachment reference in text: the UI URL or an absolute path into an attachments folder. */
const REF_RE = /(?:\/api\/attachments\/|\/attachments\/)([0-9a-f]{32}\.(?:png|jpg|gif|webp))\b/g;
const URL_RE = /\/api\/attachments\/([0-9a-f]{32}\.(?:png|jpg|gif|webp))\b/g;

export const IMAGES_NOTE = "Images in this message are local files; open them with the Read tool to see them.";

export function isAttachmentName(name: string): boolean {
  return NAME_RE.test(name);
}

export function attachmentType(name: string): string | null {
  return isAttachmentName(name) ? TYPE_OF_EXT[name.split(".").pop()!] : null;
}

/** The file's first bytes must match the declared image type (a renamed text file is rejected). */
function looksLike(type: string, b: Uint8Array): boolean {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x);
  switch (type) {
    case "image/png": return at(0, 0x89, 0x50, 0x4e, 0x47);
    case "image/jpeg": return at(0, 0xff, 0xd8, 0xff);
    case "image/gif": return at(0, 0x47, 0x49, 0x46, 0x38);
    case "image/webp": return at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50);
    default: return false;
  }
}

export class AttachmentError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Validates and saves an image; returns its file name. */
export function saveAttachment(dir: string, type: string, bytes: Uint8Array): string {
  const ext = IMAGE_TYPES[type];
  if (!ext) throw new AttachmentError(415, "only PNG, JPEG, GIF and WebP images are supported");
  if (bytes.byteLength === 0) throw new AttachmentError(400, "image is empty");
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, "image is larger than 10 MB");
  if (!looksLike(type, bytes)) throw new AttachmentError(400, `file is not a valid ${ext.toUpperCase()} image`);
  mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID().replace(/-/g, "")}.${ext}`;
  writeFileSync(join(dir, name), bytes);
  return name;
}

export function attachmentFile(dir: string, name: string): string | null {
  if (!isAttachmentName(name)) return null;
  const file = join(dir, name);
  return existsSync(file) ? file : null;
}

/** Attachment file names referenced anywhere in the given texts. */
export function referencedAttachments(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const t of texts) for (const m of t.matchAll(REF_RE)) out.add(m[1]);
  return [...out];
}

/**
 * Prompts for Claude: swap image URLs for absolute file paths (Claude's Read tool can view them) and add a
 * short note saying so, inside the board's context block when there is one.
 */
export function localizeImages(prompt: string, dir: string): string {
  if (!prompt.includes("/api/attachments/")) return prompt;
  const out = prompt.replace(URL_RE, (_, name) => join(dir, name));
  const close = out.lastIndexOf("</ckanban-context>");
  return close >= 0 ? `${out.slice(0, close)}\n${IMAGES_NOTE}\n${out.slice(close)}` : `${out}\n\n${IMAGES_NOTE}`;
}

export function deleteAttachments(dir: string, names: string[]): void {
  for (const n of names) if (isAttachmentName(n)) rmSync(join(dir, n), { force: true });
}

/** Copy attachments under new names (old name → new name), skipping ones that are gone. */
export function copyAttachments(dir: string, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of names) {
    if (!isAttachmentName(n) || !existsSync(join(dir, n))) continue;
    const copy = `${crypto.randomUUID().replace(/-/g, "")}.${n.split(".").pop()}`;
    copyFileSync(join(dir, n), join(dir, copy));
    out[n] = copy;
  }
  return out;
}
