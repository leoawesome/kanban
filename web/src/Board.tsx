import {
  closestCenter, DndContext, pointerWithin, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useMemo, useState } from "react";
import { COLUMNS, type Status, type Ticket } from "./api";
import { Card } from "./Card";

interface Props {
  tickets: Ticket[];
  onOpen: (id: string) => void;
  onMove: (id: string, status: Status, order: number) => void;
  onAdd: (status: Status) => void;
}

function SortableCard({ ticket, onOpen }: { ticket: Ticket; onOpen: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: ticket.id,
    data: { status: ticket.status },
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.35 : 1 }}
      {...attributes}
      {...listeners}
    >
      <Card ticket={ticket} onClick={() => onOpen(ticket.id)} />
    </div>
  );
}

const SPARK = (
  <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
    <path d="M8 0c.5 3.9 2.1 5.5 6 6-3.9.5-5.5 2.1-6 6-.5-3.9-2.1-5.5-6-6 3.9-.5 5.5-2.1 6-6Z" fill="currentColor" />
  </svg>
);

const DONE_LIMIT = 10;

function Column({ id, label, hint, claude, tickets, onOpen, onAdd }: {
  id: Status; label: string; hint: string; claude: boolean; tickets: Ticket[]; onOpen: (id: string) => void; onAdd: (s: Status) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { status: id } });
  const needYou = tickets.filter((t) => t.attention && !t.running && t.status !== "in_progress").length;
  const canAdd = id !== "in_progress" && id !== "done";
  // Done keeps growing: show the most recently finished cards unless expanded.
  const [showAll, setShowAll] = useState(false);
  const limited = id === "done" && !showAll && tickets.length > DONE_LIMIT;
  const shown = limited ? tickets.slice(0, DONE_LIMIT) : tickets;
  return (
    <section className={`column col-${id} ${claude ? "claude-zone" : ""} ${isOver ? "over" : ""}`}>
      <header className="column-head">
        <span className="column-title">{label}</span>
        <span className="count">{tickets.length}</span>
        {claude && <span className="claude-tag" title="Claude starts automatically when a card is here">{SPARK} Claude</span>}
        {needYou > 0 && <span className="need-chip" title="Tickets waiting on you">{needYou} need you</span>}
        <span className="spacer" />
        {canAdd ? (
          <button className="icon-btn" title={`Add to ${label}`} onClick={() => onAdd(id)}>+</button>
        ) : <span className="icon-btn-placeholder" aria-hidden />}
      </header>
      <div className="column-hint">{hint}</div>
      <SortableContext items={shown.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {shown.map((t) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} />
          ))}
          {id === "done" && tickets.length > DONE_LIMIT && (
            <button className="btn ghost small show-all" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${tickets.length}`}
            </button>
          )}
          {tickets.length === 0 && claude && (
            <div className="column-drop-hint">
              {id === "in_progress" ? "Cards show up here while Claude works" : `Drop a card here and Claude ${id === "planning" ? "starts interviewing you" : "starts working on it"}`}
            </div>
          )}
        </div>
      </SortableContext>
    </section>
  );
}

// Prefer whatever is under the pointer (a card beats its column); fall back to nearest card.
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (hits.length) {
    const card = hits.find((h) => !String(h.id).startsWith("col:"));
    return [card ?? hits[0]];
  }
  return closestCenter(args);
};

export function Board({ tickets, onOpen, onMove, onAdd }: Props) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const [dragId, setDragId] = useState<string | null>(null);

  const byColumn = useMemo(() => {
    const m = new Map<Status, Ticket[]>(COLUMNS.map((c) => [c.id, []]));
    for (const t of tickets) m.get(t.status)?.push(t);
    for (const list of m.values()) list.sort((a, b) => a.order - b.order);
    // Done reads best newest-first.
    m.get("done")?.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return m;
  }, [tickets]);

  const onDragStart = (e: DragStartEvent) => setDragId(String(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    setDragId(null);
    const { active, over } = e;
    if (!over) return;
    const ticket = tickets.find((t) => t.id === active.id);
    if (!ticket) return;
    const targetStatus = (over.data.current?.status as Status | undefined) ?? ticket.status;
    const list = (byColumn.get(targetStatus) ?? []).filter((t) => t.id !== ticket.id);
    let index = list.length;
    if (!String(over.id).startsWith("col:")) {
      const overIndex = list.findIndex((t) => t.id === over.id);
      if (overIndex >= 0) {
        const originalList = byColumn.get(targetStatus) ?? [];
        const movingDown = ticket.status === targetStatus &&
          originalList.findIndex((t) => t.id === ticket.id) < originalList.findIndex((t) => t.id === over.id);
        index = movingDown ? overIndex + 1 : overIndex;
      }
    }
    const before = list[index - 1]?.order;
    const after = list[index]?.order;
    const order = before === undefined && after === undefined ? 1
      : before === undefined ? after! - 1
      : after === undefined ? before + 1
      : (before + after) / 2;
    if (targetStatus === ticket.status && order === ticket.order) return;
    onMove(ticket.id, targetStatus, order);
  };

  const dragging = tickets.find((t) => t.id === dragId);

  return (
    <DndContext sensors={sensors} collisionDetection={collision} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragId(null)}>
      <main className="board">
        {COLUMNS.map((c) => (
          <Column key={c.id} {...c} tickets={byColumn.get(c.id) ?? []} onOpen={onOpen} onAdd={onAdd} />
        ))}
      </main>
      <DragOverlay>{dragging ? <Card ticket={dragging} dragging /> : null}</DragOverlay>
    </DndContext>
  );
}
