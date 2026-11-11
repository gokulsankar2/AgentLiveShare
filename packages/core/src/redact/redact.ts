import type { AgentCard } from "../schema.js";
import { isHighEntropySecret, TOKEN_RE } from "./entropy.js";
import { matchesAnyGlob } from "./glob.js";
import { KEYWORD_RULE, KNOWN_FORMAT_RULES, PII_RULES, type Rule, tag } from "./rules.js";

// Secret & PII redaction engine — docs/ARCHITECTURE.md §2.3.
// Fails closed: any internal error (including a bad team pattern) throws,
// and callers must treat a throw as "do not push".

/** Team config from `.agents/config.json` on the sync branch (layer 5). */
export interface RedactConfig {
  /** Extra regex sources; matches become `[REDACTED:custom]`. */
  extraPatterns?: readonly string[];
  /** Literal strings that are never redacted (min 8 chars, no whitespace, whole tokens only). */
  allowlist?: readonly string[];
  /** Globs for files that must never appear in `files.*`. */
  neverSyncPaths?: readonly string[];
}

/** Always dropped from `files.*`, in addition to the team's neverSyncPaths. */
export const DEFAULT_NEVER_SYNC_PATHS: readonly string[] = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa*",
  "id_ed25519*",
];

export interface RedactResult {
  text: string;
  /** Total replacements (feeds meta.redactions). */
  count: number;
  /** Replacements per rule id. */
  rules: Record<string, number>;
}

const MAX_EXTRA_PATTERN_LENGTH = 200;
/** Allowlist entries shorter than this could neuter a rule prefix (e.g. "ghp_"). */
const MIN_ALLOWLIST_LENGTH = 8;
/** Private-use code point marking allowlist placeholders; stripped from input first. */
const PLACEHOLDER = "";
/** Characters a token may contain (the entropy tokenizer's alphabet plus "."). */
const TOKEN_CHAR = "[A-Za-z0-9+/=_.-]";
/** Invisible format characters (zero-width space/joiners, BOM, bidi marks) that could split a secret. */
const FORMAT_CHARS = /\p{Cf}/gu;

export class RedactionError extends Error {
  override name = "RedactionError";
}

/**
 * Team patterns come from a file any teammate can write, and JS regexes have
 * no timeout. A shape check can't make arbitrary regexes safe (the security
 * review broke two versions of one), so week 1 allows only a subset that
 * can't backtrack badly: no groups, no backreferences, no lookarounds, and
 * at most ONE repeating quantifier (`+`, `*`, `{n,}`, or `{n,m}` with m>16).
 * That bounds matching at O(n²), and team patterns only run on inputs
 * ≤ MAX_EXTRA_INPUT chars. Longer inputs skip them; the egress gate (which
 * scans short card strings) then blocks instead of leaking.
 * TODO(week 4): run team patterns under RE2 or in a worker with a timeout.
 */
const MAX_EXTRA_INPUT = 4096;
const extraCache = new Map<string, RegExp>();

function repeatingQuantifiers(src: string): number {
  // Drop escapes and character classes first: quantifier chars inside them are literals.
  const bare = src.replace(/\\./g, "x").replace(/\[(?:[^\]\\]|\\.)*\]/g, "x");
  let n = 0;
  for (const m of bare.matchAll(/[+*]|\{(\d+)(,(\d*))?\}/g)) {
    if (m[0] === "+" || m[0] === "*") n++;
    else if (m[2] && (m[3] === "" || Number(m[3]) > 16)) n++;
  }
  return n;
}

function compileExtraPattern(src: unknown): Rule {
  const bad = () => new RedactionError("invalid extraPattern in team config");
  if (typeof src !== "string" || !src || src.length > MAX_EXTRA_PATTERN_LENGTH) throw bad();
  let re = extraCache.get(src);
  if (!re) {
    const unescaped = src.replace(/\\./g, "x");
    if (/[()]/.test(unescaped) || /\\[1-9]|\\k</.test(src)) throw bad();
    if (repeatingQuantifiers(src) > 1) throw bad();
    try {
      re = new RegExp(src, "g");
    } catch {
      throw bad();
    }
    if (new RegExp(src).test("")) throw bad();
    extraCache.set(src, re);
  }
  return { id: "custom", re };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applyRule(text: string, rule: Rule, stats: RedactResult): string {
  const t = tag(rule.id);
  return text.replace(rule.re, (match: string, ...args: unknown[]) => {
    // replace() passes (match, ...groups, offset, input[, namedGroups]).
    const groups = args.filter((a) => typeof a === "string" || a === undefined) as string[];
    const caps = groups.slice(0, -1).map((g) => g ?? "");
    const out = rule.replace ? rule.replace(t, match, caps) : t;
    if (out !== match) {
      stats.count++;
      stats.rules[rule.id] = (stats.rules[rule.id] ?? 0) + 1;
    }
    return out;
  });
}

function applyEntropy(text: string, stats: RedactResult): string {
  return text.replace(TOKEN_RE, (token: string, offset: number) => {
    const before = text.slice(Math.max(0, offset - 40), offset);
    const after = text.slice(offset + token.length, offset + token.length + 10);
    if (!isHighEntropySecret(token, before, after)) return token;
    stats.count++;
    stats.rules.high_entropy = (stats.rules.high_entropy ?? 0) + 1;
    return tag("high_entropy");
  });
}

/**
 * Redact one string. Layers run in spec order; each sees the previous
 * layer's output, so tags are never re-flagged.
 */
export function redactText(input: string, config: RedactConfig = {}): RedactResult {
  if (typeof input !== "string") throw new RedactionError("redactText expects a string");
  const stats: RedactResult = { text: "", count: 0, rules: {} };
  const extra = (config.extraPatterns ?? []).map(compileExtraPattern);

  let text = input.replaceAll(PLACEHOLDER, "").replace(FORMAT_CHARS, "");

  // Protect allowlisted literals behind placeholders so no layer touches them.
  // Only whole tokens are protected: an entry can't carve a prefix out of a
  // longer token (allowlisting "ghp_…" must not split a GitHub token).
  const allow = (config.allowlist ?? []).filter(
    (a) => typeof a === "string" && a.length >= MIN_ALLOWLIST_LENGTH && !/\s/.test(a),
  );
  allow.forEach((a, i) => {
    // A trailing "." followed by a non-token char is sentence punctuation, not part of the token.
    const bounded = new RegExp(`(?<!${TOKEN_CHAR})${escapeRegExp(a)}(?!\\.?[A-Za-z0-9+/=_-])`, "g");
    text = text.replace(bounded, `${PLACEHOLDER}${i}${PLACEHOLDER}`);
  });

  for (const rule of KNOWN_FORMAT_RULES) text = applyRule(text, rule, stats);
  text = applyRule(text, KEYWORD_RULE, stats);
  text = applyEntropy(text, stats);
  for (const rule of PII_RULES) text = applyRule(text, rule, stats);
  if (text.length <= MAX_EXTRA_INPUT) for (const rule of extra) text = applyRule(text, rule, stats);

  text = text.replace(
    new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, "g"),
    (_m, i: string) => allow[Number(i)] ?? "",
  );
  stats.text = text;
  return stats;
}

/** A text scrubber that also accumulates the redaction count. */
export function createScrubber(config: RedactConfig = {}) {
  const totals = { count: 0, rules: {} as Record<string, number> };
  const scrub = (s: string): string => {
    const r = redactText(s, config);
    totals.count += r.count;
    for (const [k, v] of Object.entries(r.rules)) totals.rules[k] = (totals.rules[k] ?? 0) + v;
    return r.text;
  };
  return { scrub, totals };
}

export function isNeverSyncPath(path: string, config: RedactConfig = {}): boolean {
  return matchesAnyGlob(path, [...DEFAULT_NEVER_SYNC_PATHS, ...(config.neverSyncPaths ?? [])]);
}

/**
 * Redact every free-text field of a card and drop never-sync files. Used for
 * cards that didn't go through the Tier-1 builder's scrub hook (Tier-2
 * output, MCP notes) and as a belt-and-braces pass.
 */
export function redactCard(
  card: AgentCard,
  config: RedactConfig = {},
): { card: AgentCard; count: number } {
  const { scrub, totals } = createScrubber(config);
  const keepFile = (p: string) => !isNeverSyncPath(p, config);
  const out: AgentCard = {
    ...card,
    git: { ...card.git, branch: scrub(card.git.branch) },
    intent: scrub(card.intent),
    summary: scrub(card.summary),
    tasks: card.tasks.map((t) => ({ ...t, text: scrub(t.text) })),
    files: {
      modified: card.files.modified.filter(keepFile).map(scrub),
      inProgress: card.files.inProgress.filter(keepFile).map(scrub),
    },
    claims: card.claims.map((c) => ({ ...c, glob: scrub(c.glob) })),
    decisions: card.decisions.map(scrub),
    blockers: card.blockers.map(scrub),
    notes: card.notes.map((n) => ({ ...n, text: scrub(n.text) })),
  };
  return { card: out, count: totals.count };
}

export type EgressVerdict = { ok: true } | { ok: false; reason: string; rules: string[] };

/** Every string in a parsed JSON value, keys included. */
function collectStrings(v: unknown, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
}

/**
 * Egress gate (pass 2): scan the exact bytes about to be pushed. The payload
 * is parsed and every decoded string and key is scanned on its own. Scanning
 * the raw JSON instead lets escapes like `\n` or `\"` glue a letter onto a
 * secret and defeat the boundaries, and it lets context leak across fields
 * (`"branch":"feat/auth","head":"<sha>"` read as a keyword next to a SHA).
 * Any hit, a payload that isn't JSON, or any internal error blocks the push. PII hits block too: pass 1 should have removed them, so a hit
 * means something slipped through.
 */
export function egressGate(serialized: string, config: RedactConfig = {}): EgressVerdict {
  try {
    // Validate team config even when there's nothing to scan: a bad pattern always blocks.
    for (const p of config.extraPatterns ?? []) compileExtraPattern(p);
    const strings: string[] = [];
    collectStrings(JSON.parse(serialized), strings);
    let count = 0;
    const rules = new Set<string>();
    for (const s of strings) {
      const r = redactText(s, config);
      count += r.count;
      for (const k of Object.keys(r.rules)) rules.add(k);
    }
    if (count === 0) return { ok: true };
    return {
      ok: false,
      reason: `egress gate found ${count} unredacted hit(s)`,
      rules: [...rules].sort(),
    };
  } catch (err) {
    const reason =
      err instanceof RedactionError
        ? err.message
        : err instanceof SyntaxError
          ? "payload is not valid JSON"
          : "redactor failed";
    return { ok: false, reason, rules: [] };
  }
}
