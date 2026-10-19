"use client";
import { useState, useEffect, useRef, useCallback, useId } from "react";

interface FlightSuggestion {
  flight_number: string;
  airline: string;
  departure: string;
  arrival: string;
}

interface Props {
  onSelect?: (flight: FlightSuggestion) => void;
  placeholder?: string;
}

type ErrorType = "timeout" | "rate_limit" | "api_key" | "network" | "provider" | null;

function debounce<T extends (...args: Parameters<T>) => void>(fn: T, ms: number) {
  let timer: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

const FETCH_TIMEOUT_MS = 8000;

function getErrorMessage(type: ErrorType): string {
  switch (type) {
    case "timeout":
      return "Search timed out. Check your connection or enter the flight number manually.";
    case "rate_limit":
      return "Too many requests — wait a moment, then try again.";
    case "api_key":
      return "Flight search is not configured. Enter the flight number manually.";
    case "network":
      return "Network error. Check your connection or enter the flight number manually.";
    case "provider":
      return "Flight data provider error. Try again or enter the flight number manually.";
    default:
      return "";
  }
}

/**
 * #1186 — runtime-validate a single flight record from the AviationStack
 * response.  Returns null for records that are missing the minimum fields
 * needed to render a useful suggestion.
 */
function parseFlightRecord(f: unknown): FlightSuggestion | null {
  if (f === null || typeof f !== "object") return null;
  const rec = f as Record<string, unknown>;

  const flight = rec.flight as Record<string, unknown> | null | undefined;
  const airline = rec.airline as Record<string, unknown> | null | undefined;
  const dep = rec.departure as Record<string, unknown> | null | undefined;
  const arr = rec.arrival as Record<string, unknown> | null | undefined;

  const flight_number =
    typeof flight?.iata === "string" ? flight.iata.trim() : "";

  // Require at least a non-empty flight identifier — discard otherwise.
  if (!flight_number) return null;

  return {
    flight_number,
    airline: typeof airline?.name === "string" ? airline.name : "",
    departure: typeof dep?.iata === "string" ? dep.iata : "",
    arrival: typeof arr?.iata === "string" ? arr.iata : "",
  };
}

export default function FlightSearchAutocomplete({ onSelect, placeholder = "Search flights…" }: Props) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<FlightSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [open, setOpen] = useState(false);
  const [errorType, setErrorType] = useState<ErrorType>(null);
  const [noResults, setNoResults] = useState(false);

  // #1187 — flag set when the user commits a selection; prevents the search
  // effect from firing again on the resulting query update.
  const selectionCommitted = useRef(false);

  const listRef = useRef<HTMLUListElement>(null);

  // #1185 — per-instance IDs so multiple widgets on the same page don't share IDs.
  const uid = useId();
  const listboxId = `flight-listbox-${uid}`;
  const getOptionId = (index: number) => `flight-option-${uid}-${index}`;

  const fetchSuggestions = useCallback(
    debounce(async (q: string) => {
      if (q.length < 2) {
        setSuggestions([]);
        setOpen(false);
        setErrorType(null);
        setNoResults(false);
        return;
      }

      const key = process.env.NEXT_PUBLIC_AVIATION_STACK_KEY;
      if (!key) {
        setErrorType("api_key");
        setSuggestions([]);
        setOpen(false);
        setNoResults(false);
        return;
      }

      setLoading(true);
      setErrorType(null);
      setNoResults(false);

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const res = await fetch(
          `https://api.aviationstack.com/v1/flights?access_key=${key}&flight_iata=${encodeURIComponent(q)}&limit=5`,
          { signal: controller.signal },
        );
        clearTimeout(timeoutId);

        if (res.status === 429) {
          setErrorType("rate_limit");
          setSuggestions([]);
          setOpen(false);
          return;
        }
        if (!res.ok) {
          setErrorType("provider");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const data: unknown = await res.json();

        // #1186 — validate the response envelope before accessing nested fields.
        if (data === null || typeof data !== "object") {
          setErrorType("provider");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        const envelope = data as Record<string, unknown>;

        if (envelope.error) {
          setErrorType("provider");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        // #1186 — data.data must be an array; anything else is a provider error.
        if (!Array.isArray(envelope.data)) {
          setErrorType("provider");
          setSuggestions([]);
          setOpen(false);
          return;
        }

        // #1186 — validate and discard malformed records; keep valid ones.
        const results: FlightSuggestion[] = (envelope.data as unknown[])
          .map(parseFlightRecord)
          .filter((f): f is FlightSuggestion => f !== null);

        setSuggestions(results);
        setNoResults(results.length === 0);
        setOpen(results.length > 0);
        setActiveIndex(-1);
      } catch (err) {
        clearTimeout(timeoutId);
        setErrorType((err as Error).name === "AbortError" ? "timeout" : "network");
        setSuggestions([]);
        setOpen(false);
      } finally {
        setLoading(false);
      }
    }, 350),
    [],
  );

  useEffect(() => {
    // #1187 — skip the search triggered by a programmatic query update after
    // the user selects a suggestion.  Reset the flag so the next deliberate
    // edit will search normally.
    if (selectionCommitted.current) {
      selectionCommitted.current = false;
      return;
    }
    fetchSuggestions(query);
  }, [query, fetchSuggestions]);

  const select = (flight: FlightSuggestion) => {
    // #1187 — mark the selection before updating the query so the effect
    // above can skip the resulting search.
    selectionCommitted.current = true;
    setQuery(flight.flight_number);
    setOpen(false);
    setSuggestions([]);
    setActiveIndex(-1);
    setErrorType(null);
    setNoResults(false);
    onSelect?.(flight);
  };

  const useManualEntry = () => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setOpen(false);
    setErrorType(null);
    setNoResults(false);
    onSelect?.({ flight_number: trimmed, airline: "", departure: "", arrival: "" });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      select(suggestions[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showFeedback = !loading && query.length >= 2 && (errorType !== null || noResults);
  const isError = errorType !== null;

  // #1185 — aria-activedescendant points at the currently highlighted option.
  const activeDescendant =
    open && activeIndex >= 0 ? getOptionId(activeIndex) : undefined;

  return (
    <div className="relative w-full space-y-1.5">
      <div className="relative">
        {/* #1185 — role="combobox" owns the listbox; per-instance IDs prevent collisions. */}
        <input
          type="text"
          role="combobox"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length > 0 && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeDescendant}
          aria-invalid={isError}
          className="w-full rounded-lg px-4 py-2.5 pr-10 text-sm outline-none focus:ring-2 focus:ring-blue-500"
          style={{
            background: "var(--card)",
            color: "var(--foreground)",
            border: `1px solid ${isError ? "rgba(239,68,68,0.5)" : "var(--border)"}`,
          }}
        />
        {loading && (
          <span
            aria-label="Searching…"
            className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin rounded-full border-2 border-blue-500 border-t-transparent"
          />
        )}
      </div>

      {showFeedback && (
        <div
          role={isError ? "alert" : "status"}
          className="rounded-lg px-3 py-2 text-xs flex items-start justify-between gap-2"
          style={{
            background: isError ? "rgba(239,68,68,0.06)" : "var(--card)",
            border: `1px solid ${isError ? "rgba(239,68,68,0.25)" : "var(--border)"}`,
            color: isError ? "#ef4444" : "var(--muted)",
          }}
        >
          <span>
            {noResults
              ? `No flights found for "${query}".`
              : getErrorMessage(errorType)}
          </span>
          {query.trim() && (
            <button
              type="button"
              onClick={useManualEntry}
              className="shrink-0 font-medium underline underline-offset-2 hover:opacity-80 transition-opacity whitespace-nowrap"
              style={{ color: isError ? "#ef4444" : "#3b82f6" }}
            >
              Use &ldquo;{query}&rdquo;
            </button>
          )}
        </div>
      )}

      {open && (
        <ul
          id={listboxId}
          role="listbox"
          ref={listRef}
          className="absolute z-50 mt-1 w-full rounded-lg shadow-lg overflow-hidden"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {suggestions.map((f, i) => (
            <li
              key={f.flight_number + i}
              id={getOptionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={() => select(f)}
              onMouseEnter={() => setActiveIndex(i)}
              className="flex items-center justify-between px-4 py-2.5 cursor-pointer text-sm transition-colors"
              style={{
                background: i === activeIndex ? "var(--border)" : "transparent",
                color: "var(--foreground)",
              }}
            >
              <span className="font-medium">{f.flight_number}</span>
              <span style={{ color: "var(--muted)" }} className="text-xs">
                {f.departure} → {f.arrival}
              </span>
              <span style={{ color: "var(--muted)" }} className="text-xs truncate max-w-[120px]">
                {f.airline}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
