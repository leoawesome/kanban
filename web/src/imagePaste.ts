import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { api } from "./api";

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
let seq = 0;

function imagesOf(list: DataTransfer | null): File[] {
  return Array.from(list?.files ?? []).filter((f) => f.type.startsWith("image/"));
}

/**
 * Paste or drop images into a markdown textarea: each one is uploaded and inserted at the cursor as
 * `![image](/api/attachments/…)`. Text paste is left alone.
 */
export function useImagePaste(setValue: Dispatch<SetStateAction<string>>) {
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const uploads = useRef(0);
  const [uploading, setUploading] = useState(false);

  const insert = (el: HTMLTextAreaElement, files: File[]) => {
    setError(null);
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const holders = files.map(() => `![uploading image ${++seq}…]()`);
    const text = holders.join("\n");
    setValue((v) => v.slice(0, start) + text + v.slice(end));
    requestAnimationFrame(() => el.setSelectionRange(start + text.length, start + text.length));
    files.forEach(async (file, i) => {
      uploads.current++;
      setUploading(true);
      try {
        if (!IMAGE_TYPES.includes(file.type)) throw new Error("only PNG, JPEG, GIF and WebP images are supported");
        const { url } = await api.uploadImage(file);
        setValue((v) => v.replace(holders[i], `![image](${url})`));
      } catch (e: any) {
        setValue((v) => v.replace(new RegExp(`\\n?${holders[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), ""));
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
