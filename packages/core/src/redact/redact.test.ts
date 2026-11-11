import { describe, it } from "vitest";

// Work queue for the redaction engine — docs/ARCHITECTURE.md §2.3.
// Backlog: turn each todo into a real test (fixtures in fixtures/secrets/), then implement.

describe("redact: layer 1 — known-format secrets", () => {
  it.todo("redacts AWS access key ids (AKIA…) as [REDACTED:aws_access_key]");
  it.todo("redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_)");
  it.todo("redacts Anthropic (sk-ant-) and OpenAI (sk-, sk-proj-) keys");
  it.todo("redacts Slack (xox?-), Stripe ([sr]k_live/test_) and Google (AIza…) keys");
  it.todo("redacts JWTs (eyJ….eyJ….sig)");
  it.todo("redacts full PEM private key blocks, including multi-line bodies");
  it.todo("redacts credentials embedded in URLs (scheme://user:pass@host)");
  it.todo("redacts Bearer tokens in header-like text");
  it.todo("uses a stable tag per rule so repeated runs produce identical output");
});

describe("redact: layer 2 — keyword assignments", () => {
  it.todo("redacts the value in api_key=…, token: …, password = '…' (case-insensitive)");
  it.todo("keeps the key name and only replaces the value");
  it.todo("ignores values shorter than 8 characters");
});

describe("redact: layer 3 — high-entropy tokens", () => {
  it.todo("flags base64-ish tokens ≥20 chars with Shannon entropy > 4.5 bits/char");
  it.todo("flags hex-only tokens ≥32 chars with entropy > 3.5");
  it.todo("does not flag git SHAs (7–40 hex) unless a secret keyword is within 20 chars");
  it.todo("does not flag UUIDs, sha512- integrity hashes, or file paths");
  it.todo("does not flag ordinary camelCase / snake_case identifiers");
});

describe("redact: layer 4 — PII", () => {
  it.todo("redacts email addresses");
  it.todo("redacts E.164-style phone numbers");
  it.todo("rewrites /Users/<name>/ and /home/<name>/ prefixes to ~/");
  it.todo("redacts public IPv4 addresses but keeps private ranges (10/8, 172.16/12, 192.168/16)");
});

describe("redact: layer 5 — team config", () => {
  it.todo("applies extraPatterns from .agents/config.json");
  it.todo("never redacts strings matching allowlist entries");
  it.todo("drops file paths matching neverSyncPaths globs (e.g. .env*, secrets/**)");
});

describe("redact: egress gate and failure handling", () => {
  it.todo("reports the number of redactions (feeds meta.redactions)");
  it.todo("egress gate: blocks the push when a second pass still finds a secret");
  it.todo("fails closed: an internal error blocks the push instead of passing text through");
  it.todo(
    "100% recall on fixtures/secrets/positive, <1% false positives on fixtures/secrets/negative",
  );
});
