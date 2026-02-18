export interface PagerState {
  lines: readonly string[];
  pageSize: number;
  offset: number;
}

export interface PagerViewport {
  readonly lines: readonly string[];
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
  readonly pageIndex: number;
  readonly pageCount: number;
}

function clamp(value: number, minValue: number, maxValue: number): number {
  if (value < minValue) return minValue;
  if (value > maxValue) return maxValue;
  return value;
}

function normalizedPageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) return 1;
  return Math.max(1, Math.floor(pageSize));
}

function maxOffset(lineCount: number, pageSize: number): number {
  return Math.max(0, lineCount - pageSize);
}

export function createPager(lines: readonly string[], pageSize: number): PagerState {
  return {
    lines: [...lines],
    pageSize: normalizedPageSize(pageSize),
    offset: 0
  };
}

export function setPagerLines(pager: PagerState, lines: readonly string[], pageSize: number): PagerState {
  const nextPageSize = normalizedPageSize(pageSize);
  pager.lines = [...lines];
  pager.pageSize = nextPageSize;
  pager.offset = clamp(pager.offset, 0, maxOffset(pager.lines.length, nextPageSize));
  return pager;
}

export function pagerTop(pager: PagerState): PagerState {
  pager.offset = 0;
  return pager;
}

export function pagerBottom(pager: PagerState): PagerState {
  pager.offset = maxOffset(pager.lines.length, pager.pageSize);
  return pager;
}

export function pagerLineDown(pager: PagerState): PagerState {
  pager.offset = clamp(pager.offset + 1, 0, maxOffset(pager.lines.length, pager.pageSize));
  return pager;
}

export function pagerLineUp(pager: PagerState): PagerState {
  pager.offset = clamp(pager.offset - 1, 0, maxOffset(pager.lines.length, pager.pageSize));
  return pager;
}

export function pagerPageDown(pager: PagerState): PagerState {
  pager.offset = clamp(pager.offset + pager.pageSize, 0, maxOffset(pager.lines.length, pager.pageSize));
  return pager;
}

export function pagerPageUp(pager: PagerState): PagerState {
  pager.offset = clamp(pager.offset - pager.pageSize, 0, maxOffset(pager.lines.length, pager.pageSize));
  return pager;
}

export function pagerJumpToLine(pager: PagerState, lineIndex: number): PagerState {
  const normalizedLineIndex = Number.isFinite(lineIndex) ? Math.floor(lineIndex) : 0;
  const boundedLineIndex = clamp(normalizedLineIndex, 0, Math.max(0, pager.lines.length - 1));
  pager.offset = clamp(boundedLineIndex, 0, maxOffset(pager.lines.length, pager.pageSize));
  return pager;
}

export function pagerViewport(pager: PagerState): PagerViewport {
  const totalLines = pager.lines.length;
  if (totalLines === 0) {
    return {
      lines: [],
      startLine: 0,
      endLine: 0,
      totalLines: 0,
      pageIndex: 1,
      pageCount: 1
    };
  }

  const pageSize = normalizedPageSize(pager.pageSize);
  const maxPagerOffset = maxOffset(totalLines, pageSize);
  const startLine = clamp(pager.offset, 0, maxPagerOffset);
  const endLine = Math.min(totalLines, startLine + pageSize);
  const pageCount = Math.max(1, Math.ceil(totalLines / pageSize));
  const pageIndex = Math.min(pageCount, Math.floor(startLine / pageSize) + 1);

  return {
    lines: pager.lines.slice(startLine, endLine),
    startLine: startLine + 1,
    endLine,
    totalLines,
    pageIndex,
    pageCount
  };
}
