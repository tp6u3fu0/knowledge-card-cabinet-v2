"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ApiCard } from "../collection/types";

/**
 * The overlay that answers a question without making you leave what you are
 * doing.
 *
 * This is the whole product argument in one screen: somebody writing Spring
 * Boot forgets what the thing that wraps a method is called, and the cost of
 * finding out has to be a keystroke, not a window. Opening the cabinet, waiting
 * for it, finding the search field and typing is already too much — by then
 * they have gone to a search engine instead.
 *
 * So this window is kept alive and hidden between uses, it takes no route
 * through the collection, and it never asks for anything the reader did not
 * type. It is a different client of `GET /search`, not a different search:
 * a second endpoint would grow a second ranking, and one of the two would rot.
 */

type QuickBridge = {
  close: () => Promise<void>;
  openCard: (id: string) => Promise<void>;
  shortcut: () => Promise<string | null>;
};

type Hit = ApiCard & { search_reasons?: string[] };

/**
 * Shorter than the collection's 250ms, because the two surfaces are not doing
 * the same job. Browsing a cabinet tolerates a pause; this is meant to answer
 * before you have finished deciding you asked.
 *
 * Measured in the real overlay, typing a phrase through an IME at 220ms per
 * commit, five runs each, timing from the last keystroke to the answer being on
 * screen — not to the request settling, which an aborted one does instantly
 * while showing nothing:
 *
 *   250ms   835ms  (635–1039)   1 request
 *   150ms   293ms  (286–299)   12 requests, 11 of them aborted
 *
 * Every run at 150 beat every run at 250. Part of that is the 100ms; the rest
 * is that firing while someone types keeps the model warm, so the request that
 * matters is not the first one after an idle gap. The spec's budget for
 * shortcut-to-useful-result is 500ms, which 250 does not meet and 150 does.
 *
 * The cost is real and was measured too: about eleven extra embeddings per
 * lookup, since aborting a fetch does not stop the server finishing the work.
 * A lookup happens a few times an hour, so that is a second of CPU against
 * half a second of someone's attention.
 *
 * Below 150 was not adopted. At a fast enough cadence every keystroke becomes
 * a request and the abort rate is already 11 in 12; there is nothing left to
 * buy (CLAUDE.md §3.16).
 */
const DEBOUNCE_MS = 150;

function bridge(): QuickBridge | null {
  return (globalThis as unknown as { quickSearch?: QuickBridge }).quickSearch ?? null;
}

export default function QuickSearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [cursor, setCursor] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // What is on screen, rather than what was last fetched: an empty box has no
  // results whatever the last request came back with, and deriving that keeps
  // the keyboard handler from ever acting on a card the reader cannot see.
  const results = useMemo(() => (query.trim() && !failed ? hits : []), [failed, hits, query]);

  // The window is shown and hidden rather than created and destroyed, so focus
  // has to be taken every time it comes back, not only on mount.
  useEffect(() => {
    const focus = () => inputRef.current?.focus();
    focus();
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}&limit=8`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("search failed");
        const result = (await response.json()) as Hit[];
        if (!Array.isArray(result)) throw new Error("bad response");
        setHits(result);
        setFailed(false);
        setCursor(0);
        setExpanded(false);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        // Saying nothing here would read as "you have never written that down",
        // which is a much worse answer than "the cabinet is not reachable".
        setHits([]);
        setFailed(true);
      }
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // Keep the selected row on screen when the arrows walk past the fold.
  useEffect(() => {
    listRef.current?.children[cursor]?.scrollIntoView({ block: "nearest" });
  }, [cursor, expanded]);

  const close = useCallback(() => {
    setQuery("");
    setHits([]);
    setExpanded(false);
    void bridge()?.close();
  }, []);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    const current = results[cursor];
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setCursor((index) => (index + step + results.length) % results.length);
      // Moving off a row closes what it had opened: the list is the place you
      // steer from, and steering through expanded cards is unreadable.
      setExpanded(false);
      return;
    }
    if (event.key === "Enter" && current) {
      event.preventDefault();
      // Enter reads it here; the modifier hands it to the cabinet. The common
      // case is the one without a modifier — you wanted the sentence, not the
      // application.
      if (event.metaKey || event.ctrlKey) {
        void bridge()?.openCard(current.id);
        close();
        return;
      }
      setExpanded((open) => !open);
    }
  }, [close, cursor, results]);

  return (
    <div className="quick">
      <div className="quick__field">
        <svg className="quick__glass" viewBox="0 0 18 18" fill="none" aria-hidden="true" focusable="false">
          <circle cx="8" cy="8" r="5.2" />
          <path d="M11.9 11.9 15.5 15.5" />
        </svg>
        <input
          ref={inputRef}
          className="quick__input"
          type="text"
          value={query}
          spellCheck={false}
          autoComplete="off"
          placeholder="想起一件事的模糊描述"
          aria-label="搜尋知識卡"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      {query.trim() && failed ? (
        <p className="quick__empty">連不上本機卡冊，請確認主程式還在執行。</p>
      ) : query.trim() && results.length === 0 ? (
        <p className="quick__empty">卡冊裡沒有這件事。</p>
      ) : results.length > 0 ? (
        <ul className="quick__hits" ref={listRef}>
          {results.map((hit, index) => (
            <li key={hit.id}>
              <button
                className={`quick__hit ${index === cursor ? "is-cursor" : ""}`}
                type="button"
                tabIndex={-1}
                onMouseEnter={() => setCursor(index)}
                onClick={() => setExpanded((open) => (index === cursor ? !open : true))}
              >
                <span className="quick__hit-head">
                  <span>{hit.number}</span>
                  <span>{hit.category ?? hit.topic}</span>
                  {hit.search_reasons?.length ? (
                    <span className="quick__hit-why">{hit.search_reasons.join(" · ")}</span>
                  ) : null}
                </span>
                <strong>{hit.title}</strong>
                {hit.summary ? <span className="quick__hit-summary">{hit.summary}</span> : null}
                {index === cursor && expanded ? (
                  <span className="quick__hit-more">
                    {hit.question ? <span><em>問題</em>{hit.question}</span> : null}
                    {hit.analogy ? <span><em>比喻</em>{hit.analogy}</span> : null}
                    {hit.detail ? <span><em>細節</em>{hit.detail}</span> : null}
                    {hit.source ? <span><em>來源</em>{hit.source}</span> : null}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <p className="quick__keys">
        <kbd>↑</kbd><kbd>↓</kbd> 選擇 <kbd>Enter</kbd> 展開 <kbd>⌘/Ctrl</kbd>+<kbd>Enter</kbd> 在卡冊開啟 <kbd>Esc</kbd> 關閉
      </p>
    </div>
  );
}
