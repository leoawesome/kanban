import { api, type Ticket } from "./api";
import { toast } from "./toast";

/** Branch a ticket (copy of its conversation + committed code) and open the new one. */
export async function branchTicket(slug: string, ticket: Ticket, open: (id: string) => void): Promise<Ticket> {
  const { ticket: b, warning } = await api.branchTicket(slug, ticket.id);
  open(b.id);
  toast(warning ? <>Branched <b>{ticket.title}</b>. {warning}</> : <>Branched <b>{ticket.title}</b></>, { tone: warning ? "info" : "ok", ...(warning ? { ms: 9000 } : {}) });
  return b;
}
