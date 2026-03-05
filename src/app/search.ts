export interface SearchState {
  readonly query: string;
  readonly matchLineIndices: readonly number[];
  readonly activeMatchIndex: number;
}

function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

function findMatches(lines: readonly string[], query: string): number[] {
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) {
    return [];
  }
  const matches: number[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (line.toLowerCase().includes(normalized)) {
      matches.push(lineIndex);
    }
  }
  return matches;
}/**
 * Computes deterministic public output for `createSearchState`.
 */


export function createSearchState(lines: readonly string[], query: string): SearchState {
  const matchLineIndices = findMatches(lines, query);
  return {
    query: query.trim(),
    matchLineIndices,
    activeMatchIndex: matchLineIndices.length > 0 ? 0 : -1
  };
}/**
 * Provides deterministic public behavior for `hasSearchMatches`.
 */


export function hasSearchMatches(state: SearchState): boolean {
  return state.matchLineIndices.length > 0 && state.activeMatchIndex >= 0;
}/**
 * Provides deterministic public behavior for `activeSearchLineIndex`.
 */


export function activeSearchLineIndex(state: SearchState): number | null {
  if (!hasSearchMatches(state)) {
    return null;
  }
  return state.matchLineIndices[state.activeMatchIndex] ?? null;
}/**
 * Provides deterministic public behavior for `moveSearchMatch`.
 */


export function moveSearchMatch(state: SearchState, direction: "next" | "prev"): SearchState {
  if (!hasSearchMatches(state)) {
    return state;
  }
  const matchCount = state.matchLineIndices.length;
  const delta = direction === "next" ? 1 : -1;
  const nextIndex = (state.activeMatchIndex + delta + matchCount) % matchCount;
  return {
    ...state,
    activeMatchIndex: nextIndex
  };
}
