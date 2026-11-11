import { SECRET_KEYWORD } from "./rules.js";

// Layer 3: high-entropy tokens — docs/ARCHITECTURE.md §2.3.

export const MIN_TOKEN_LENGTH = 20;
export const BASE64_ENTROPY = 4.5;
export const HEX_ENTROPY = 3.5;
export const HEX_MIN_LENGTH = 32;
/** How far before a SHA-shaped token we look for a secret keyword. */
const KEYWORD_WINDOW = 20;

/** Candidate tokens: runs of the base64/base64url alphabet, ≥20 chars; `=` only as padding. */
export const TOKEN_RE = /[A-Za-z0-9+/_-]{20,}={0,2}/g;

export function shannonEntropy(s: string): number {
  if (!s.length) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTEGRITY_RE = /^sha(?:1|256|384|512)-/;
const HASH_PREFIX_RE = /(?:sha(?:1|256|384|512)|md5)[:=-]$/i;
/** Known source/config extensions; anything else after a "/" token isn't proof of a path. */
const FILE_EXT_RE =
  /^\.(?:[cm]?[jt]sx?|json|md|mdx|py|go|rs|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|css|scss|html|vue|svelte|ya?ml|toml|txt|sh|lock|sql|png|svg|jpg|gif|ipynb|xml|gradle|dart)(?![A-Za-z0-9])/;
/** AWS secret access keys: 40 chars of base64 without "=", next to an "aws" keyword. */
const AWS_SECRET_RE = /^[A-Za-z0-9/+]{40}$/;

/**
 * Character-class transitions per character (lower→upper, letter↔digit),
 * ignoring separators. Identifiers change class once per word (~0.1–0.25);
 * random base64 changes class on ~40% of characters.
 */
export function classTransitionRate(token: string): number {
  const cls = (c: string) =>
    /[a-z]/.test(c) ? "l" : /[A-Z]/.test(c) ? "u" : /\d/.test(c) ? "d" : "s";
  let prev = "s";
  let transitions = 0;
  let chars = 0;
  for (const c of token) {
    const k = cls(c);
    if (k === "s") {
      prev = "s";
      continue;
    }
    chars++;
    if (prev !== "s" && prev !== k && !(prev === "u" && k === "l")) transitions++;
    prev = k;
  }
  return chars ? transitions / chars : 0;
}

const IDENTIFIER_MAX_TRANSITIONS = 0.3;

/**
 * Decide whether a candidate token is a secret. `before`/`after` are the
 * surrounding text, used for the context-dependent suppressions.
 */
export function isHighEntropySecret(token: string, before: string, after: string): boolean {
  if (UUID_RE.test(token) || INTEGRITY_RE.test(token)) return false;
  if (HASH_PREFIX_RE.test(before)) return false;

  if (/^[0-9a-f]+$/i.test(token)) {
    // Git SHAs are everywhere in agent transcripts; only a nearby keyword makes one suspect.
    if (token.length <= 40) return SECRET_KEYWORD.test(before.slice(-KEYWORD_WINDOW));
    return token.length >= HEX_MIN_LENGTH && shannonEntropy(token) > HEX_ENTROPY;
  }

  // Their entropy is often ≤ 4.5 (vendor examples especially), so context decides.
  if (AWS_SECRET_RE.test(token) && /aws/i.test(before.slice(-40))) return true;

  // Paths: contain "/" and are followed by a known file extension.
  if (token.includes("/") && FILE_EXT_RE.test(after)) return false;
  if (shannonEntropy(token) <= BASE64_ENTROPY) return false;
  // camelCase / snake_case / kebab-case identifiers and word-like paths.
  return classTransitionRate(token) > IDENTIFIER_MAX_TRANSITIONS;
}
