// Pure parser for engine progress lines. Used by the renderer to turn
// stdout chunks into structured `RunProgress` state.
//
// No DOM / no Electron imports — runs in vitest without setup.

export interface RunProgress {
  /** Total enabled rules at the start of the run. Set by the renderer. */
  totalRules: number;
  /**
   * The rule the engine is currently working on, if we've seen its
   * `── Rule: NAME` header. `index` is 1-based.
   */
  currentRule: { name: string; index: number } | null;
  /**
   * The latest pair-progress within the current rule, or null when the
   * engine hasn't emitted one (small rules skip it entirely).
   */
  pairs: { done: number; total: number } | null;
  /**
   * Rolling log of recent engine output lines. Capped — see
   * `MAX_RECENT_LINES` — so it doesn't grow unboundedly on long runs.
   */
  recentLines: string[];
  /** When the run started, in epoch ms. Used to show elapsed time. */
  startedAt: number;
}

const MAX_RECENT_LINES = 200;

export function freshProgress(totalRules: number): RunProgress {
  return {
    totalRules,
    currentRule: null,
    pairs: null,
    recentLines: [],
    startedAt: Date.now(),
  };
}

/**
 * Apply a single engine output line to the progress state.
 * Pure — returns a new object, never mutates.
 *
 * Recognised line patterns (the engine prints these in stable form):
 *
 *   ── Rule: HVACxSTR ──────────
 *       → starts the next rule; bumps `currentRule.index`, resets pairs.
 *
 *   Side A  ARK.ifc  total=… selector='…' matched=… excluded=…
 *   Side B  STR.ifc  total=… selector='…' matched=… excluded=…
 *   Checking N × M element pairs…
 *       → no state change; just appended to recentLines.
 *
 *     progress: 5000/100000 pairs
 *       → updates `pairs`. Emitted only when total pairs > 1000.
 *
 *   → K clash(es) found
 *       → resets pairs (rule done), waits for the next Rule: line.
 */
export function applyProgressLine(p: RunProgress, line: string): RunProgress {
  const recentLines = appendRecent(p.recentLines, line);

  const ruleMatch = line.match(/── Rule:\s*(\S+)/);
  if (ruleMatch) {
    const nextIndex = (p.currentRule?.index ?? 0) + 1;
    return {
      ...p,
      currentRule: { name: ruleMatch[1] ?? "?", index: nextIndex },
      pairs: null,
      recentLines,
    };
  }

  const pairsMatch = line.match(/\bprogress:\s*(\d+)\s*\/\s*(\d+)\s*pairs/);
  if (pairsMatch) {
    return {
      ...p,
      pairs: {
        done: Number.parseInt(pairsMatch[1] ?? "0", 10),
        total: Number.parseInt(pairsMatch[2] ?? "0", 10),
      },
      recentLines,
    };
  }

  const ruleDoneMatch = line.match(/→\s*\d+\s*clash/);
  if (ruleDoneMatch) {
    return { ...p, pairs: null, recentLines };
  }

  return { ...p, recentLines };
}

function appendRecent(prev: string[], line: string): string[] {
  if (prev.length < MAX_RECENT_LINES) {
    return [...prev, line];
  }
  // Drop the oldest line to keep the array bounded.
  return [...prev.slice(prev.length - MAX_RECENT_LINES + 1), line];
}

// ─── Derived display helpers (also pure) ──────────────────────────────────────

/** Compose a short status string for the TopBar. */
export function shortStatus(p: RunProgress): string {
  if (!p.currentRule) {
    return "Loading…";
  }
  const ruleTxt = p.totalRules > 0
    ? `Rule ${p.currentRule.index}/${p.totalRules}: ${p.currentRule.name}`
    : `Rule: ${p.currentRule.name}`;
  if (p.pairs) {
    const pct = Math.round((100 * p.pairs.done) / Math.max(1, p.pairs.total));
    return `${ruleTxt} (${pct}%)`;
  }
  return ruleTxt;
}

/** Elapsed seconds since the run started. */
export function elapsedSeconds(p: RunProgress, now: number = Date.now()): number {
  return Math.max(0, (now - p.startedAt) / 1000);
}
