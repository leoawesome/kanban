import { useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";
import { insertBlock, mapIndex, swapHolder, type Edit } from "./imageText";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
let seq = 0;

function imagesOf(list: DataTransfer | null): File[] {
  return Array.from(list?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Paste or drop images into a markdown textarea: each one is uploaded and inserted at the cursor, on its
 * own line, as `![image](/api/attachments/…)`. Text paste is left alone.
 */
export function useImagePaste(setValue: Dispatch<SetStateAction<string>>) {
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useRef(0);
  const [uploading, setUploading] = useState(false);

  // Where the caret should go once the edited value is rendered (a controlled textarea loses it otherwise).
  const caret = useRef<{ el: HTMLTextAreaElement; value: string; start: number; end: number } | null>(null);
  useLayoutEffect(() => {
    const c = caret.current;
    caret.current = null;
    if (c && c.el.value === c.value && document.activeElement === c.el) c.el.setSelectionRange(c.start, c.end);
  });

  // Apply an edit to the latest state. The textarea's selection refers to what it shows, which can lag
  // behind state by a not-yet-rendered update, so it is mapped onto the state first.
  const edit = (el: HTMLTextAreaElement, f: (v: string, start: number, end: number) => Edit) =>
    setValue((v) => {
      const shown = el.value;
      const r = f(v, mapIndex(shown, v, el.selectionStart ?? shown.length), mapIndex(shown, v, el.selectionEnd ?? shown.length));
      caret.current = { el, ...r };
      return r.value;
    });

  const insert = (el: HTMLTextAreaElement, files: File[]) => {
    setError(null);
    const holders = files.map(() => `![uploading image ${++seq}…]()`);
    edit(el, (v, start, end) => insertBlock(v, start, end, holders));
    files.forEach(async (file, i) => {
      uploads.current++;
      setUploading(true);
      try {
        if (!IMAGE_TYPES.includes(file.type)) throw new Error("only PNG, JPEG, GIF and WebP images are supported");
        const { url } = await api.uploadImage(file);
        edit(el, (v, start, end) => swapHolder(v, holders[i], `![image](${url})`, start, end));
      } catch (e: any) {
        edit(el, (v, start, end) => swapHolder(v, holders[i], "", start, end));
        setError(`Image not added: ${e.message}`);
      } finally {
        if (--uploads.current === 0) setUploading(false);
      }
    });
  };

  const handlers = {
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = imagesOf(e.clipboardData);
      if (!files.length) return;
      e.preventDefault();
      insert(e.currentTarget, files);
    },
    onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => {
      if (!Array.from(e.dataTransfer.items).some((i) => i.kind === "file")) return;
      e.preventDefault();
      setDragOver(true);
    },
    onDragLeave: () => setDragOver(false),
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => {
      setDragOver(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const files = imagesOf(e.dataTransfer);
      if (!files.length) return setError("Only images can be dropped here (PNG, JPEG, GIF or WebP).");
      insert(e.currentTarget, files);
    },
  };

  return { handlers, error, uploading, dragOver, clearError: () => setError(null) };
}
