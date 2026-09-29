/**
 * Turns `--include-partial-messages` stream events into the text Claude has written so far
 * in the current message, so the chat can show replies while they are being written.
 * feed() returns the new draft when it changed ("" = cleared), or null when nothing changed.
 */
export class DraftTracker {
  text = "";
  private blockHasText = false;

  feed(ev: any): string | null {
    if (ev?.type === "assistant" && !ev.parent_tool_use_id) {
      // The finished message is now in the session file; drop the live copy.
      if (!this.text) return null;
      this.reset();
      return "";
    }
    if (ev?.type !== "stream_event" || ev.parent_tool_use_id) return null;
    const e = ev.event ?? {};
    if (e.type === "message_start") {
      const had = !!this.text;
      this.reset();
      return had ? "" : null;
    }
    if (e.type === "content_block_start") {
      this.blockHasText = false;
      return null;
    }
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") {
      if (!this.blockHasText && this.text) this.text += "\n\n";
      this.blockHasText = true;
      this.text += e.delta.text;
      return this.text;
    }
    return null;
  }

  private reset() {
    this.text = "";
    this.blockHasText = false;
  }
}
