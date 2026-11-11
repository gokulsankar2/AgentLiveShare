import { fileURLToPath } from "node:url";
import { AgentCard, TARGET_CARD_BYTES } from "@als/core";
import { describe, expect, it } from "vitest";
import { distillCommand, type Io } from "./distill.js";

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../../fixtures/transcripts/${name}`, import.meta.url));

function fakeIo(exec: Record<string, string> = {}, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    env,
    exec: (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      return exec[key];
    },
  };
  return { io, out, err, calls };
}

const NOW = ["--now", "2026-11-11T10:07:30Z"];
const GIT = "git -c core.fsmonitor=false -c core.hooksPath=/dev/null";

describe("als distill", () => {
  it("prints a valid card ≤1 KB for a transcript", async () => {
    const { io, out, err } = fakeIo();
    const code = await distillCommand(
      [
        fixture("synthetic-cli.jsonl"),
        "--login",
        "dev",
        "--head",
        "abc1234",
        "--repo-root",
        "/home/dev/project",
        "--json",
        ...NOW,
      ],
      io,
    );
    expect(err.join("")).toContain("bytes (target 1024)");
    expect(code).toBe(0);
    const json = out.join("").trim();
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(TARGET_CARD_BYTES);
    const card = AgentCard.parse(JSON.parse(json));
    expect(card.agentId).toBe("dev--c0ffee00");
    expect(card.blockers).toEqual(["Repeated Bash failures"]);
    expect(err.join("")).toContain("skipped lines: future-entry-type×1, malformed×1");
  });

  it("falls back to ALS_LOGIN, git config, then gh for the login", async () => {
    const args = [fixture("synthetic-cli.jsonl"), "--head", "abc1234", "--repo-root", "/r", ...NOW];
    const env = fakeIo({}, { ALS_LOGIN: "from-env" });
    expect(await distillCommand(args, env.io)).toBe(0);
    expect(env.out.join("")).toContain('"login": "from-env"');

    const gh = fakeIo({ "gh api user --jq .login": "from-gh" });
    expect(await distillCommand(args, gh.io)).toBe(0);
    expect(gh.calls).toEqual(["git config --get github.user", "gh api user --jq .login"]);
    expect(gh.out.join("")).toContain('"login": "from-gh"');

    const none = fakeIo();
    expect(await distillCommand(args, none.io)).toBe(2);
    expect(none.err.join("")).toContain("no GitHub login found");
  });

  it("reads repo root and HEAD from git when not given", async () => {
    const { io, out, calls } = fakeIo({
      [`${GIT} rev-parse --show-toplevel`]: "/home/dev/project",
      [`${GIT} rev-parse --short HEAD`]: "1a2b3c4",
    });
    expect(
      await distillCommand([fixture("synthetic-cli.jsonl"), "--login", "dev", ...NOW], io),
    ).toBe(0);
    expect(calls).toEqual([`${GIT} rev-parse --show-toplevel`, `${GIT} rev-parse --short HEAD`]);
    const card = JSON.parse(out.join(""));
    expect(card.git).toEqual({ branch: "feat/refresh-tokens", head: "1a2b3c4" });
    expect(card.files.modified).toContain("src/auth/refresh.ts");
  });

  it("exits 2 with a hint when HEAD can't be read", async () => {
    const { io, err } = fakeIo();
    expect(await distillCommand([fixture("synthetic-cli.jsonl"), "--login", "dev"], io)).toBe(2);
    expect(err.join("")).toContain("pass --head");
  });

  it("pretty output is the gated payload re-indented", async () => {
    const args = [
      fixture("synthetic-cli.jsonl"),
      "--login",
      "dev",
      "--head",
      "abc1234",
      "--repo-root",
      "/r",
      ...NOW,
    ];
    const pretty = fakeIo();
    const compact = fakeIo();
    await distillCommand(args, pretty.io);
    await distillCommand([...args, "--json"], compact.io);
    expect(JSON.stringify(JSON.parse(pretty.out.join("")))).toBe(compact.out.join("").trim());
  });

  it("rejects an invalid login, a non-ISO --now, and never prints a stack trace", async () => {
    const base = [fixture("synthetic-cli.jsonl"), "--head", "abc1234", "--repo-root", "/r"];
    const bad = fakeIo();
    expect(await distillCommand([...base, "--login", "not valid!"], bad.io)).toBe(2);
    expect(bad.err.join("")).not.toContain("not valid!");
    expect(
      await distillCommand([...base, "--login", "dev", "--now", "Jan 1 2025"], fakeIo().io),
    ).toBe(2);
    const boom = fakeIo();
    boom.io.exec = () => {
      throw new TypeError("secret-bearing message");
    };
    expect(await distillCommand([fixture("synthetic-cli.jsonl")], boom.io)).toBe(1);
    expect(boom.err.join("")).toBe("als distill: failed (TypeError)\n");
  });

  it("rejects bad usage and unreadable files", async () => {
    expect(await distillCommand([], fakeIo().io)).toBe(2);
    expect(await distillCommand(["a", "b"], fakeIo().io)).toBe(2);
    expect(await distillCommand(["x.jsonl", "--bogus"], fakeIo().io)).toBe(2);
    const missing = fakeIo();
    expect(await distillCommand(["/nonexistent/x.jsonl", "--login", "dev"], missing.io)).toBe(2);
    expect(missing.err.join("")).toContain("ENOENT");
  });
});
