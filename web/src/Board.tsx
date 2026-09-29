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

function Column({ id, label, hint, tickets, onOpen, onAdd }: {
  id: Status; label: string; hint: string; tickets: Ticket[]; onOpen: (id: string) => void; onAdd: (s: Status) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${id}`, data: { status: id } });
  return (
    <section className={`column col-${id} ${isOver ? "over" : ""}`}>
      <header className="column-head">
        <span className="column-title">{label}</span>
        <span className="count">{tickets.length}</span>
        {id !== "in_progress" && id !== "done" && (
          <button className="icon-btn" title={`Add to ${label}`} onClick={() => onAdd(id)}>
            +
          </button>
        )}
      </header>
      {hint && <div className="column-hint">{hint}</div>}
      <SortableContext items={tickets.map((t) => t.id)} strategy={verticalListSortingStrategy}>
        <div ref={setNodeRef} className="column-body">
          {tickets.map((t) => (
            <SortableCard key={t.id} ticket={t} onOpen={onOpen} />
          ))}
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
