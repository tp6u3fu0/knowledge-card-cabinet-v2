"use client";

/**
 * Picking a card up and carrying it, rather than dragging a shadow of it.
 *
 * The HTML5 drag-and-drop API this replaced hands the browser a translucent
 * bitmap of the element and leaves the element itself sitting still, which in a
 * cabinet of cards reads as "a copy came loose" rather than "I am holding this
 * one". Pointer events let the actual card move: it lifts out of the pile,
 * follows the cursor, and either lands in the slot or falls back into place.
 *
 * The moving part is deliberately imperative. A card follows the pointer at
 * screen refresh rate and React does not need to know about any frame of it —
 * only about the two states that change layout (a card is out of the pile, a
 * slot is armed), which is what the store below publishes.
 */

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

/** How far the pointer must travel before this counts as a drag and not a click. */
const DRAG_THRESHOLD_PX = 6;
/** How long the card takes to fall back when it is not dropped on a slot. */
const RETURN_MS = 220;

type SlotEntry = { kind: string; onDrop: (cardId: string) => void };

const slots = new Map<string, SlotEntry>();
const listeners = new Set<() => void>();

let carried: { cardId: string; kind: string } | null = null;
let hovered = "";
/** Stable between publishes so useSyncExternalStore does not loop. */
let snapshot: { kind: string; cardId: string; overSlot: string } = { kind: "", cardId: "", overSlot: "" };

function publish() {
  snapshot = { kind: carried?.kind ?? "", cardId: carried?.cardId ?? "", overSlot: hovered };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Server render has no drag in progress, and never will. */
const EMPTY = { kind: "", cardId: "", overSlot: "" };

export function useDragState() {
  return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY);
}

/**
 * A slot announces itself so a card released over it can find it.
 *
 * Registration is by id rather than by React context because the card being
 * dragged and the slot receiving it are siblings in the DOM but not always in
 * the tree — the simple and advanced pickers arrange them differently, and a
 * shared registry means neither has to thread a handler through the other.
 */
export function useSlotRegistration(kind: string, onDrop?: (cardId: string) => void) {
  const slotId = useId();
  const handler = useRef(onDrop);
  const droppable = Boolean(onDrop);

  useEffect(() => {
    handler.current = onDrop;
  }, [onDrop]);

  useEffect(() => {
    if (!droppable) return undefined;
    slots.set(slotId, { kind, onDrop: (cardId) => handler.current?.(cardId) });
    return () => {
      slots.delete(slotId);
    };
  }, [slotId, kind, droppable]);

  return slotId;
}

function slotUnderPointer(x: number, y: number, exclude: Element | null) {
  for (const element of document.elementsFromPoint(x, y)) {
    if (exclude && (element === exclude || exclude.contains(element))) continue;
    const well = element.closest("[data-card-slot]");
    const id = well?.getAttribute("data-card-slot");
    if (id && slots.has(id)) return id;
  }
  return "";
}

/**
 * Makes one card carryable.
 *
 * Returns the ref to attach to the card element, the pointer handler, and the
 * size the card occupied before it lifted — the caller renders a placeholder of
 * that size so the pile does not close up while a card is in the air.
 */
export function useCardDrag({
  cardId,
  kind,
  disabled = false,
}: {
  cardId: string;
  kind: string;
  disabled?: boolean;
}) {
  const nodeRef = useRef<HTMLElement | null>(null);
  const [gap, setGap] = useState<{ width: number; height: number } | null>(null);

  /**
   * The fanned-out position of a card is a transform on its deck slot, and a
   * transformed ancestor becomes the containing block for anything `fixed`
   * inside it — a carried card would then be positioned against the slot rather
   * than the viewport and would drift by exactly the fan offset. Measure first,
   * then flatten the slot: the card is already holding viewport coordinates, so
   * nothing moves, and the placeholder left behind is invisible anyway.
   */
  const holderOf = (node: HTMLElement) => node.closest<HTMLElement>(".card-deck__item");

  const release = useCallback((animate: boolean) => {
    const node = nodeRef.current;
    carried = null;
    hovered = "";
    publish();
    if (!node) {
      setGap(null);
      return;
    }
    const holder = holderOf(node);
    const clear = () => {
      for (const property of ["position", "left", "top", "width", "height", "margin", "transform", "transition"]) {
        node.style.removeProperty(property);
      }
      if (holder) {
        // The deck slot animates its transform, and the one it is going back to
        // is the fanned-out position it was flattened from. Left to itself it
        // would take 320ms to travel there from the rail origin, carrying the
        // card that has only just landed — the card arrives, then slides across
        // the screen a second time. Restore the position with the transition
        // still suppressed, force the style to land, and only then hand the
        // slot back to CSS.
        holder.style.removeProperty("transform");
        void holder.offsetWidth;
        holder.style.removeProperty("transition");
      }
      setGap(null);
    };
    if (!animate) {
      clear();
      return;
    }
    // Identity transform is the spot the card came from, because the fixed
    // position it is holding was measured there.
    node.style.transition = `transform ${RETURN_MS}ms cubic-bezier(0.22, 0.7, 0.3, 1)`;
    node.style.transform = "translate3d(0, 0, 0)";
    window.setTimeout(clear, RETURN_MS);
  }, []);

  const onPointerDown = useCallback(
    (event: { button: number; pointerId: number; clientX: number; clientY: number }) => {
      const node = nodeRef.current;
      if (disabled || event.button !== 0 || !node) return;

      const startX = event.clientX;
      const startY = event.clientY;
      let lifted = false;

      const lift = () => {
        const bounds = node.getBoundingClientRect();
        const holder = holderOf(node);
        if (holder) {
          holder.style.transition = "none";
          holder.style.transform = "none";
        }
        setGap({ width: bounds.width, height: bounds.height });
        node.style.position = "fixed";
        node.style.left = `${bounds.left}px`;
        node.style.top = `${bounds.top}px`;
        node.style.width = `${bounds.width}px`;
        node.style.height = `${bounds.height}px`;
        node.style.margin = "0";
        node.style.transition = "none";
        carried = { cardId, kind };
        publish();
        lifted = true;
      };

      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!lifted) {
          if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
          lift();
        }
        node.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(2.4deg) scale(1.04)`;
        const over = slotUnderPointer(moveEvent.clientX, moveEvent.clientY, node);
        if (over !== hovered) {
          hovered = over;
          publish();
        }
      };

      const finish = (endEvent: PointerEvent, cancelled: boolean) => {
        node.removeEventListener("pointermove", move);
        node.removeEventListener("pointerup", up);
        node.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", onKey);
        try {
          node.releasePointerCapture(endEvent.pointerId);
        } catch {
          /* already released */
        }
        if (!lifted) return;
        // A drag that ends anywhere must not also read as a click on the card.
        node.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true });
        const target = cancelled ? "" : slotUnderPointer(endEvent.clientX, endEvent.clientY, node);
        const slot = target ? slots.get(target) : undefined;
        if (slot && slot.kind === kind) {
          release(false);
          slot.onDrop(cardId);
        } else {
          release(true);
        }
      };

      const up = (upEvent: PointerEvent) => finish(upEvent, false);
      const cancel = (cancelEvent: PointerEvent) => finish(cancelEvent, true);
      const onKey = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape" || !lifted) return;
        node.removeEventListener("pointermove", move);
        window.removeEventListener("keydown", onKey);
        release(true);
      };

      try {
        node.setPointerCapture(event.pointerId);
      } catch {
        /* synthetic pointer ids in tests */
      }
      node.addEventListener("pointermove", move);
      node.addEventListener("pointerup", up);
      node.addEventListener("pointercancel", cancel);
      window.addEventListener("keydown", onKey);
    },
    [cardId, disabled, kind, release],
  );

  useEffect(() => () => {
    if (carried?.cardId === cardId) {
      carried = null;
      hovered = "";
      publish();
    }
  }, [cardId]);

  const ref = useCallback((node: HTMLElement | null) => {
    nodeRef.current = node;
  }, []);

  return { ref, onPointerDown, gap, isDragging: gap !== null };
}
