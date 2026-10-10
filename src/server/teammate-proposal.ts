// propose_teammate: Claude proposes a teammate (huddle role preset) and the user saves it with one click. In a ticket
// chat it is a card built from the tool call in the transcript (session.ts); a huddle agent's goes to the huddle's
// Learnings (huddle.ts). Nothing is saved until the user clicks; runs can't save presets themselves (http.ts).
import { type HuddlePreset, presetFromInput, presetName } from "./huddle-presets";

/** The fields Claude gave; ones it left out keep an existing teammate's values (or the defaults for a new one). */
export type TeammateProposal = Pick<HuddlePreset, "name" | "prompt"> & Partial<Omit<HuddlePreset, "name" | "prompt">> & {
  /** One line: why no existing teammate fits. */
  why: string;
};

export const WHY_MAX = 400;

/** The proposal from propose_teammate's input; throws a readable message when it is invalid. */
export function teammateProposal(input: any): TeammateProposal {
  presetFromInput(input);
  const why = typeof input.why === "string" ? input.why.trim() : "";
  if (!why) throw new Error("why is required: one line on why no existing teammate fits");
  if (why.length > WHY_MAX) throw new Error(`why is too long (max ${WHY_MAX} characters)`);
  const out: TeammateProposal = { name: presetName(input.name), prompt: input.prompt.trim(), why };
  if (typeof input.role === "string" && input.role.trim()) out.role = input.role.trim();
  if (input.model !== undefined) out.model = typeof input.model === "string" && input.model.trim() ? input.model.trim() : null;
  if (input.mode !== undefined) out.mode = input.mode;
  if (input.workspace !== undefined) out.workspace = input.workspace;
  if (input.canEdit !== undefined) out.canEdit = input.canEdit;
  if (input.lead !== undefined) out.lead = input.lead;
  return out;
}

/** Like teammateProposal, but null for input that can't be read (an old or broken tool call in a transcript). */
export function parseTeammateProposal(input: unknown): TeammateProposal | null {
  try {
    return teammateProposal(input);
  } catch {
    return null;
  }
}

/** The preset fields to save (the user's scope comes separately). */
export function proposalPreset({ why: _w, ...p }: TeammateProposal): Partial<HuddlePreset> & { name: string } {
  return p;
}
