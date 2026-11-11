import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeChunk, initialTailState, readNewLines, type TailState } from "./tailer.js";

function feed(chunks: (string | Buffer)[], max?: number) {
  let state: TailState = initialTailState();
  const lines: string[] = [];
  for (const c of chunks) {
    const step = consumeChunk(state, typeof c === "string" ? Buffer.from(c) : c, max);
    state = step.state;
    lines.push(...step.lines);
  }
  return { state, lines };
}

describe("consumeChunk", () => {
  it("emits complete lines and buffers the trailing partial line", () => {
    const { state, lines } = feed(['{"a":1}\n{"b":', '2}\n{"c"']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(state.partial.toString()).toBe('{"c"');
    expect(state.offset).toBe(Buffer.byteLength('{"a":1}\n{"b":2}\n{"c"'));
  });

  it("does not corrupt a multi-byte character split across chunks", () => {
    const bytes = Buffer.from('{"t":"héllo ✓"}\n');
    const cut = bytes.indexOf(Buffer.from("✓")) + 1; // inside the 3-byte sequence
    const { lines } = feed([bytes.subarray(0, cut), bytes.subarray(cut)]);
    expect(lines).toEqual(['{"t":"héllo ✓"}']);
  });

  it("strips CR from CRLF line endings and skips blank lines", () => {
    expect(feed(["a\r\n\n  \nb\n"]).lines).toEqual(["a", "b"]);
  });

  it("skips lines over the size limit and counts them", () => {
    const { lines, state } = feed([`${"x".repeat(50)}\nok\n`], 20);
    expect(lines).toEqual(["ok"]);
    expect(state.skippedLines).toBe(1);
  });

  it("skips an oversized line that spans many chunks without buffering it", () => {
    const { lines, state } = feed(["x".repeat(15), "x".repeat(15), "x".repeat(15), "\nnext\n"], 20);
    expect(lines).toEqual(["next"]);
    expect(state.skippedLines).toBe(1);
    expect(state.partial.length).toBe(0);
  });
});

describe("readNewLines", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "als-tail-"));
    file = join(dir, "s.jsonl");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads incrementally from the stored byte offset", async () => {
    writeFileSync(file, "one\ntw");
    const first = await readNewLines(file, initialTailState());
    expect(first.lines).toEqual(["one"]);
    appendFileSync(file, "o\nthree\n");
    const second = await readNewLines(file, first.state);
    expect(second.lines).toEqual(["two", "three"]);
    expect(second.reset).toBe(false);
    const third = await readNewLines(file, second.state);
    expect(third.lines).toEqual([]);
  });

  it("resets to offset 0 when the file shrinks (truncated or rewritten)", async () => {
    writeFileSync(file, "a-long-first-line\nsecond\n");
    const first = await readNewLines(file, initialTailState());
    writeFileSync(file, "new\n");
    const second = await readNewLines(file, first.state);
    expect(second.reset).toBe(true);
    expect(second.lines).toEqual(["new"]);
    expect(second.state.offset).toBe(4);
  });

  it("handles files larger than one read chunk", async () => {
    const line = `${"y".repeat(1000)}\n`;
    writeFileSync(file, line.repeat(1500)); // ~1.5 MB > 1 MB chunk
    const { lines } = await readNewLines(file, initialTailState());
    expect(lines).toHaveLength(1500);
  });
});
