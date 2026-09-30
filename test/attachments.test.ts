import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  AttachmentError, attachmentFile, IMAGES_NOTE, localizeImages, MAX_ATTACHMENT_BYTES, referencedAttachments, saveAttachment,
} from "../src/server/attachments";
import { tempDir } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const NAME = "0123456789abcdef0123456789abcdef.png";

test("saveAttachment stores a random name with the right extension", () => {
  const dir = tempDir("ck-att-");
  const name = saveAttachment(dir, "image/png", PNG);
  expect(name).toMatch(/^[0-9a-f]{32}\.png$/);
  expect(attachmentFile(dir, name)).toBe(join(dir, name));
});

test("saveAttachment rejects wrong types, bad bytes and oversize files", () => {
  const dir = tempDir("ck-att-");
  const status = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      return (e as AttachmentError).status;
    }
    return 0;
  };
  expect(status(() => saveAttachment(dir, "image/svg+xml", PNG))).toBe(415);
  expect(status(() => saveAttachment(dir, "image/jpeg", PNG))).toBe(400);
  expect(status(() => saveAttachment(dir, "image/png", new Uint8Array()))).toBe(400);
  const big = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
  big.set(PNG);
  expect(status(() => saveAttachment(dir, "image/png", big))).toBe(413);
});

test("attachmentFile only accepts generated names", () => {
  const dir = tempDir("ck-att-");
  expect(attachmentFile(dir, "../ticket.md")).toBeNull();
  expect(attachmentFile(dir, "x.png")).toBeNull();
  expect(attachmentFile(dir, NAME)).toBeNull(); // valid name, but no file
});

test("localizeImages swaps URLs for file paths and adds the note inside the context", () => {
  const dir = "/data/attachments";
  const prompt = `look ![image](/api/attachments/${NAME})\n\n<ckanban-context note="">\nrules\n</ckanban-context>`;
  const out = localizeImages(prompt, dir);
  expect(out).toContain(`![image](${dir}/${NAME})`);
  expect(out).not.toContain("/api/attachments/");
  expect(out.indexOf(IMAGES_NOTE)).toBeLessThan(out.indexOf("</ckanban-context>"));
  expect(localizeImages("no images", dir)).toBe("no images");
});

test("referencedAttachments finds URLs and local paths", () => {
  expect(referencedAttachments(`![a](/api/attachments/${NAME})`, `/home/x/.claude-kanban/attachments/${NAME.replace(".png", ".jpg")}`, "none"))
    .toEqual([NAME, NAME.replace(".png", ".jpg")]);
});
