"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";

export type CardSelectOption = {
  value: string;
  label: string;
  /** A second line, for options whose label alone does not say enough. */
  note?: string;
  disabled?: boolean;
};

/** How long the closing animation runs. Must match card-select-close in globals.css. */
const CLOSE_MS = 130;
/** Options past this one all start together, so a long list does not crawl open. */
const STAGGER_CAP = 6;
const PANEL_GAP = 6;
const PANEL_MAX_HEIGHT = 320;
/** How long a run of keystrokes counts as one word when jumping to an option. */
const TYPE_AHEAD_MS = 700;

type Anchor = { left: number; top: number; width: number; maxHeight: number; from: "top" | "bottom" };

/**
 * The cabinet's dropdown.
 *
 * A native `<select>` opens an operating-system menu: on Windows that is a grey
 * list with square corners and a hard shadow, which is the one part of the app
 * that looks like it belongs to a different program. This is the same control
 * drawn in the cabinet's own hand — a card that unfolds under the trigger.
 *
 * It keeps the listbox keyboard contract (arrows, Home/End, type-ahead, Enter,
 * Escape) because a picker that only answers to the mouse is a downgrade, and
 * it carries a hidden required input when a form needs one, so submitting an
 * empty field still stops at the browser's own validation.
 */
export function CardSelect({
  label,
  value,
  options,
  onChange,
  className = "",
  placeholder = "請選擇",
  required = false,
  disabled = false,
  name,
}: {
  /** Sits beside the control, the way the old `<label><span>` did. */
  label?: string;
  value: string;
  options: CardSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  name?: string;
}) {
  const reactId = useId();
  const labelId = `${reactId}-label`;
  const listId = `${reactId}-list`;
  const optionId = (index: number) => `${reactId}-option-${index}`;

  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [active, setActive] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });

  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  /**
   * Where the panel goes. Measured rather than laid out in flow: the trigger
   * lives inside toolbars and cards that scroll and clip, and a menu that gets
   * cut off by its own container is worse than the native one it replaced.
   */
  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const below = window.innerHeight - rect.bottom - PANEL_GAP * 2;
    const above = rect.top - PANEL_GAP * 2;
    const dropsDown = below >= Math.min(PANEL_MAX_HEIGHT, above) || below >= above;
    setAnchor({
      left: rect.left,
      top: dropsDown ? rect.bottom + PANEL_GAP : rect.top - PANEL_GAP,
      width: rect.width,
      maxHeight: Math.max(120, Math.min(PANEL_MAX_HEIGHT, dropsDown ? below : above)),
      from: dropsDown ? "top" : "bottom",
    });
  }, []);

  const openPanel = () => {
    if (disabled) return;
    measure();
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setClosing(false);
    setOpen(true);
  };

  const closePanel = useCallback((restoreFocus = true) => {
    setOpen((wasOpen) => {
      if (wasOpen) setClosing(true);
      return false;
    });
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const commit = (index: number) => {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closePanel();
  };

  // The closing animation needs the panel to stay mounted while it plays.
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setClosing(false), CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      closePanel(false);
    };
    // Capture: a scroll container between here and the window still moves us.
    const onScroll = () => measure();
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, closePanel, measure]);

  // Keep the active option in view when the arrows walk past the fold.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector(`#${CSS.escape(optionId(active))}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  const step = (delta: number) => {
    setActive((current) => {
      const total = options.length;
      for (let hop = 1; hop <= total; hop += 1) {
        const next = (current + delta * hop + total * total) % total;
        if (!options[next]?.disabled) return next;
      }
      return current;
    });
  };

  const jumpToTyped = (character: string) => {
    const now = Date.now();
    const text = now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text + character : character;
    typed.current = { text, at: now };
    const match = options.findIndex(
      (option) => !option.disabled && option.label.toLowerCase().startsWith(text.toLowerCase()),
    );
    if (match >= 0) setActive(match);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        closePanel();
      }
      return;
    }
    if (event.key === "Tab") {
      if (open) closePanel(false);
      return;
    }
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openPanel();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
        // Typing at a closed picker walks the value the way a native one does.
        event.preventDefault();
        openPanel();
        jumpToTyped(event.key);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown": event.preventDefault(); step(1); break;
      case "ArrowUp": event.preventDefault(); step(-1); break;
      case "Home": event.preventDefault(); setActive(0); break;
      case "End": event.preventDefault(); setActive(options.length - 1); break;
      case "Enter":
      case " ": event.preventDefault(); commit(active); break;
      default:
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          jumpToTyped(event.key);
        }
    }
  };

  const panel = anchor && (open || closing) ? (
    <div
      ref={panelRef}
      className={`card-select__panel ${closing ? "is-closing" : ""} card-select__panel--${anchor.from}`}
      style={{
        left: `${anchor.left}px`,
        top: anchor.from === "top" ? `${anchor.top}px` : "auto",
        bottom: anchor.from === "bottom" ? `${window.innerHeight - anchor.top}px` : "auto",
        minWidth: `${anchor.width}px`,
        maxHeight: `${anchor.maxHeight}px`,
      }}
    >
      <ul className="card-select__list" id={listId} role="listbox" aria-labelledby={labelId}>
        {options.map((option, index) => (
          <li key={option.value || `blank-${index}`} className="card-select__row">
            <button
              type="button"
              id={optionId(index)}
              role="option"
              aria-selected={option.value === value}
              className={`card-select__option ${index === active ? "is-active" : ""} ${option.value === value ? "is-chosen" : ""}`}
              style={{ "--i": Math.min(index, STAGGER_CAP) } as CSSProperties}
              disabled={option.disabled}
              // Pointer down would close the panel before the click landed.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => commit(index)}
            >
              <span className="card-select__mark" aria-hidden="true" />
              <span className="card-select__text">
                {option.label}
                {option.note ? <em>{option.note}</em> : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <span className={`card-select ${open ? "is-open" : ""} ${className}`}>
      {label ? (
        <span className="card-select__label" id={labelId}>
          {label}
        </span>
      ) : null}
      <button
        ref={triggerRef}
        type="button"
        className="card-select__trigger"
        role="combobox"
        aria-controls={listId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open ? optionId(active) : undefined}
        aria-labelledby={label ? labelId : undefined}
        disabled={disabled}
        onClick={() => (open ? closePanel() : openPanel())}
        onKeyDown={onKeyDown}
      >
        <span className={`card-select__current ${selected ? "" : "is-placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <span className="card-select__chevron" aria-hidden="true" />
      </button>
      {/* Not display:none — a hidden field is skipped by validation, and the
          point of this one is to let a form still refuse to submit empty. */}
      {required ? (
        <input
          className="card-select__validity"
          tabIndex={-1}
          aria-hidden="true"
          name={name}
          required
          value={value}
          onChange={() => undefined}
          onFocus={() => triggerRef.current?.focus()}
        />
      ) : null}
      {panel && typeof document !== "undefined" ? createPortal(panel, document.body) : null}
    </span>
  );
}
