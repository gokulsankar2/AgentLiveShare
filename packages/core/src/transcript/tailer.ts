import { open, stat } from "node:fs/promises";

// Incremental JSONL tailer — docs/ARCHITECTURE.md §2.1.
// Byte offsets (not char offsets) so a restart resumes exactly where it left
// off; the partial line is kept as bytes so a multi-byte UTF-8 character split
// across two reads is never corrupted.

/** Lines longer than this are skipped (pasted images / base64 blobs). */
export const MAX_LINE_BYTES = 2 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;

export interface TailState {
  /** Bytes of the file consumed so far, including any buffered partial line. */
  offset: number;
  /** Trailing bytes after the last newline, waiting for the rest of the line. */
  partial: Buffer;
  /** True while discarding the remainder of an oversized line. */
  skipping: boolean;
  /** Count of oversized lines dropped (surfaced as a metric). */
  skippedLines: number;
}

export function initialTailState(): TailState {
  return { offset: 0, partial: Buffer.alloc(0), skipping: false, skippedLines: 0 };
}

/**
 * Pure step: append `chunk` to the buffered partial line and return every
 * complete line. Oversized lines are dropped without buffering them whole.
 */
export function consumeChunk(
  state: TailState,
  chunk: Buffer,
  maxLineBytes = MAX_LINE_BYTES,
): { state: TailState; lines: string[] } {
  const lines: string[] = [];
  let { partial, skipping, skippedLines } = state;
  let start = 0;

  for (let nl = chunk.indexOf(NEWLINE, start); nl !== -1; nl = chunk.indexOf(NEWLINE, start)) {
    const piece = chunk.subarray(start, nl);
    start = nl + 1;
    if (skipping) {
      skipping = false;
      continue;
    }
    if (partial.length + piece.length > maxLineBytes) {
      skippedLines++;
      partial = Buffer.alloc(0);
      continue;
    }
    const line = partial.length ? Buffer.concat([partial, piece]) : piece;
    partial = Buffer.alloc(0);
    const text = line.toString("utf8").replace(/\r$/, "");
    if (text.trim()) lines.push(text);
  }

  const rest = chunk.subarray(start);
  if (skipping) {
    // Still inside an oversized line: keep discarding.
  } else if (partial.length + rest.length > maxLineBytes) {
    skippedLines++;
    skipping = true;
    partial = Buffer.alloc(0);
  } else if (rest.length) {
    partial = Buffer.concat([partial, rest]);
  }

  return {
    state: { offset: state.offset + chunk.length, partial, skipping, skippedLines },
    lines,
  };
}

export interface TailResult {
  state: TailState;
  lines: string[];
  /** True when the file shrank (truncated/rewritten): callers must rebuild derived state. */
  reset: boolean;
}

/** Read everything appended to `path` since `state.offset`. */
export async function readNewLines(
  path: string,
  state: TailState,
  maxLineBytes = MAX_LINE_BYTES,
): Promise<TailResult> {
  const { size } = await stat(path);
  let reset = false;
  let current = state;
  if (size < current.offset) {
    reset = true;
    current = { ...initialTailState(), skippedLines: state.skippedLines };
  }
  const lines: string[] = [];
  if (size === current.offset) return { state: current, lines, reset };

  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(READ_CHUNK_BYTES);
    while (current.offset < size) {
      const want = Math.min(READ_CHUNK_BYTES, size - current.offset);
      const { bytesRead } = await fh.read(buf, 0, want, current.offset);
      if (bytesRead === 0) break;
      const step = consumeChunk(current, buf.subarray(0, bytesRead), maxLineBytes);
      current = step.state;
      lines.push(...step.lines);
    }
  } finally {
    await fh.close();
  }
  return { state: current, lines, reset };
}
