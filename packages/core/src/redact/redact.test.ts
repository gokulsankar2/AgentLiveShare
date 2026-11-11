import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AgentCard } from "../schema.js";
import { classTransitionRate, isHighEntropySecret, shannonEntropy } from "./entropy.js";
import { globToRegExp, matchesAnyGlob } from "./glob.js";
import { egressGate, isNeverSyncPath, redactCard, redactText } from "./redact.js";

// docs/ARCHITECTURE.md §2.3. Corpus in fixtures/secrets/{positive,negative}/.

const corpusDir = (kind: string) =>
  new URL(`../../../../fixtures/secrets/${kind}/`, import.meta.url);
function corpus(kind: "positive" | "negative"): { file: string; rule: string; text: string }[] {
  const dir = corpusDir(kind);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .flatMap((file) =>
      readFileSync(new URL(file, dir), "utf8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#"))
        .map((l) => ({
          file,
          rule: file.replace(/\.txt$/, ""),
          // "\n" → newline (PEM cases); "<split>" is removed (keeps scanner-matched shapes out of the repo).
          text: l.replaceAll("\\n", "\n").replaceAll("<split>", ""),
        })),
    );
}

const r = (s: string) => redactText(s).text;

describe("redact: layer 1 — known-format secrets", () => {
  it("redacts AWS access key ids (AKIA…) as [REDACTED:aws_access_key]", () => {
    expect(r("key AKIAIOSFODNN7EXAMPLE here")).toBe("key [REDACTED:aws_access_key] here");
  });

  it("redacts GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ and github_pat_)", () => {
    for (const p of ["ghp", "gho", "ghu", "ghs", "ghr"]) {
      expect(r(`${p}_${"A1".repeat(18)}`)).toBe("[REDACTED:github_pat]");
    }
    expect(r(`github_pat_${"x_Y9".repeat(21)}`)).toBe("[REDACTED:github_pat]");
  });

  it("redacts Anthropic (sk-ant-) and OpenAI (sk-, sk-proj-) keys", () => {
    expect(r(`sk-ant-api03-${"Ab3-".repeat(8)}`)).toBe("[REDACTED:anthropic_key]");
    expect(r(`sk-proj-${"Ab3_".repeat(8)}`)).toBe("[REDACTED:openai_key]");
    expect(r(`sk-${"x9".repeat(12)}`)).toBe("[REDACTED:openai_key]");
    expect(r("sk-learn-style-kebab-case-identifier")).toBe("sk-learn-style-kebab-case-identifier");
  });

  it("redacts Slack (xox?-), Stripe ([sr]k_live/test_) and Google (AIza…) keys", () => {
    expect(r("xoxb-EXAMPLE-not-a-real-token")).toBe("[REDACTED:slack_token]");
    expect(r(`sk_live_${"EXAMPLEKEY".repeat(3)}`)).toBe("[REDACTED:stripe_key]");
    expect(r(`AIza${"E".repeat(35)}`)).toBe("[REDACTED:google_api_key]");
  });

  it("redacts JWTs (eyJ….eyJ….sig)", () => {
    expect(r("t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl")).toBe("t=[REDACTED:jwt]");
  });

  it("redacts full PEM private key blocks, including multi-line bodies", () => {
    const pem =
      "-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\nAwEHoUQDQgAE\n-----END EC PRIVATE KEY-----";
    expect(r(`before\n${pem}\nafter`)).toBe("before\n[REDACTED:private_key]\nafter");
    expect(r("-----BEGIN PRIVATE KEY-----\nMIIEvQ (cut off")).toBe("[REDACTED:private_key]");
  });

  it("redacts credentials embedded in URLs (scheme://user:pass@host)", () => {
    expect(r("postgres://admin:hunter2@db:5432/app")).toBe(
      "postgres://[REDACTED:url_credentials]@db:5432/app",
    );
    expect(r("https://github.com/o/r")).toBe("https://github.com/o/r");
  });

  it("redacts Bearer tokens in header-like text", () => {
    expect(r("Authorization: Bearer abcdefghijklmnop.qrs")).toBe(
      "Authorization: Bearer [REDACTED:bearer_token]",
    );
  });

  it("uses a stable tag per rule so repeated runs produce identical output", () => {
    const input = "AKIAIOSFODNN7EXAMPLE and dev@example.com";
    const once = redactText(input);
    expect(redactText(input)).toEqual(once);
    expect(redactText(once.text).count).toBe(0); // idempotent: tags are never re-flagged
  });
});

describe("redact: layer 2 — keyword assignments", () => {
  it("redacts the value in api_key=…, token: …, password = '…' (case-insensitive)", () => {
    expect(r("API_KEY=abcd1234efgh")).toBe("API_KEY=[REDACTED:secret_assignment]");
    expect(r("token: zzzzzzzzzz")).toBe("token: [REDACTED:secret_assignment]");
    expect(r("Password = 'hunter2hunter2'")).toBe("Password = '[REDACTED:secret_assignment]'");
    expect(r('{"clientSecret":"abcdefgh12"}')).toBe(
      '{"clientSecret":"[REDACTED:secret_assignment]"}',
    );
  });

  it("keeps the key name and only replaces the value", () => {
    expect(r("DB_PASSWORD=s3cretValue!")).toBe("DB_PASSWORD=[REDACTED:secret_assignment]");
  });

  it("ignores values shorter than 8 characters", () => {
    expect(r("token=abc1234")).toBe("token=abc1234");
  });

  it("does not treat 'author' or obviously benign values as secrets", () => {
    expect(r("author: Dev User Name")).toBe("author: Dev User Name");
    expect(r("authentication: required")).toBe("authentication: required");
    expect(r("authorization=abcdefgh1234")).toBe("authorization=[REDACTED:secret_assignment]");
  });
});

describe("redact: layer 3 — high-entropy tokens", () => {
  it("flags base64-ish tokens ≥20 chars with Shannon entropy > 4.5 bits/char", () => {
    const tok = "Xd5rJ2A8lSOxB1nOg9bu22k90geNkMwikEx7f0wQ";
    expect(shannonEntropy(tok)).toBeGreaterThan(4.5);
    expect(r(`v=${tok}`)).toBe("v=[REDACTED:high_entropy]");
    expect(r("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("flags hex-only tokens ≥32 chars with entropy > 3.5", () => {
    const hex64 = "430760fec52c8ac5fa0ad9cb561f63e21aeb5d9c70913ae934c9bb79a2091148";
    expect(r(hex64)).toBe("[REDACTED:high_entropy]");
  });

  it("does not flag git SHAs (7–40 hex) unless a secret keyword is within 20 chars", () => {
    const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    expect(r(`commit ${sha}`)).toBe(`commit ${sha}`);
    expect(r(`the token ${sha}`)).toBe("the token [REDACTED:high_entropy]");
    expect(isHighEntropySecret(sha, `token ${"x".repeat(25)} `, "")).toBe(false);
  });

  it("does not flag UUIDs, sha512- integrity hashes, or file paths", () => {
    expect(r("4136cfd1-6b2f-47e2-a1d8-1f2d23259d27")).toBe("4136cfd1-6b2f-47e2-a1d8-1f2d23259d27");
    const integrity = `sha512-${"Q9xZ+k2/Lm8P".repeat(7)}==`;
    expect(r(integrity)).toBe(integrity);
    const path = "src/Xd5rJ2A8lSOxB1nOg9bu22k/k90geNkMwikEx7f0wQ.ts";
    expect(r(path)).toBe(path);
  });

  it("does not flag ordinary camelCase / snake_case identifiers", () => {
    expect(classTransitionRate("getUserProfileByIdAndOrganization")).toBeLessThan(0.3);
    expect(classTransitionRate("Xd5rJ2A8lSOxB1nOg9bu22k90geN")).toBeGreaterThan(0.3);
    for (const id of ["getUserProfileByIdAndOrganization", "SOME_VERY_LONG_CONSTANT_NAME_VALUE"]) {
      expect(r(id)).toBe(id);
    }
  });
});

describe("redact: layer 4 — PII", () => {
  it("redacts email addresses", () => {
    expect(r("mail dev@example.com now")).toBe("mail [REDACTED:email] now");
    expect(r("zod@4.6.7 and @als/core")).toBe("zod@4.6.7 and @als/core");
  });

  it("redacts E.164-style phone numbers", () => {
    expect(r("+14155550123")).toBe("[REDACTED:phone]");
    expect(r("(555) 123-4567")).toBe("[REDACTED:phone]");
    expect(r("2026-11-11T20:38:18.436Z")).toBe("2026-11-11T20:38:18.436Z");
  });

  it("rewrites /Users/<name>/ and /home/<name>/ prefixes to ~/", () => {
    expect(r("/Users/alice/p/x.ts and /home/bob/.ssh")).toBe("~/p/x.ts and ~/.ssh");
    expect(r("C:\\Users\\carol\\repo")).toBe("~\\repo");
  });

  it("redacts public IPv4 addresses but keeps private ranges (10/8, 172.16/12, 192.168/16)", () => {
    expect(r("8.8.8.8 10.0.0.1 172.20.0.5 192.168.1.10 127.0.0.1")).toBe(
      "[REDACTED:ipv4] 10.0.0.1 172.20.0.5 192.168.1.10 127.0.0.1",
    );
    expect(r("172.32.0.1")).toBe("[REDACTED:ipv4]");
  });
});

describe("redact: layer 5 — team config", () => {
  it("applies extraPatterns from .agents/config.json", () => {
    expect(
      redactText("ticket ACME-INTERNAL-42", { extraPatterns: ["ACME-INTERNAL-\\d+"] }).text,
    ).toBe("ticket [REDACTED:custom]");
  });

  it("never redacts strings matching allowlist entries", () => {
    const cfg = { allowlist: ["dev@example.com", "ab"] }; // "ab" is too short and ignored
    expect(redactText("dev@example.com other@example.com", cfg).text).toBe(
      "dev@example.com [REDACTED:email]",
    );
    expect(redactText("x\uE0000\uE000y", cfg).text).toBe("x0y"); // placeholder chars are stripped from input
    expect(redactText("mail dev@example.com.", cfg).text).toBe("mail dev@example.com.");
  });

  it("drops file paths matching neverSyncPaths globs (e.g. .env*, secrets/**)", () => {
    const cfg = { neverSyncPaths: ["secrets/**", "config/*.local.json"] };
    expect(isNeverSyncPath("app/.env.production", cfg)).toBe(true);
    expect(isNeverSyncPath("secrets/prod/db.txt", cfg)).toBe(true);
    expect(isNeverSyncPath("config/app.local.json", cfg)).toBe(true);
    expect(isNeverSyncPath("config/deep/app.local.json", cfg)).toBe(false);
    expect(isNeverSyncPath("src/env.ts", cfg)).toBe(false);
    expect(globToRegExp("a/**/b.ts").test("a/b.ts")).toBe(true);
    expect(matchesAnyGlob("./x/y.pem", ["*.pem"])).toBe(true);
    expect(isNeverSyncPath("secrets/prod/db.txt", { neverSyncPaths: ["secrets"] })).toBe(true);
    expect(isNeverSyncPath("app/secrets/db.txt", { neverSyncPaths: ["secrets/"] })).toBe(true);
    expect(isNeverSyncPath("APP/.ENV", {})).toBe(true);
    expect(isNeverSyncPath("C:\\p\\id_rsa.pub", {})).toBe(true);
  });
});

const baseCard = (): AgentCard => ({
  v: 1,
  agentId: "dev--c0ffee00",
  owner: { login: "dev" },
  tool: "claude-code",
  seq: 1,
  updatedAt: "2026-11-11T10:00:00Z",
  status: "active",
  git: { branch: "main", head: "abc1234" },
  intent: "Ship it",
  summary: "",
  tasks: [],
  files: { modified: [], inProgress: [] },
  claims: [],
  decisions: [],
  blockers: [],
  notes: [],
  meta: { distillTier: 1, redactions: 0, engine: "0.1.0" },
});

describe("redact: egress gate and failure handling", () => {
  it("reports the number of redactions (feeds meta.redactions)", () => {
    const res = redactText("AKIAIOSFODNN7EXAMPLE dev@example.com 8.8.8.8");
    expect(res.count).toBe(3);
    expect(res.rules).toEqual({ aws_access_key: 1, email: 1, ipv4: 1 });
    const { card, count } = redactCard({
      ...baseCard(),
      intent: "use AKIAIOSFODNN7EXAMPLE",
      tasks: [{ text: "mail dev@example.com", state: "pending" }],
      files: { modified: [".env", "src/a.ts"], inProgress: [".env"] },
    });
    expect(count).toBe(2);
    expect(card.intent).toBe("use [REDACTED:aws_access_key]");
    expect(card.files).toEqual({ modified: ["src/a.ts"], inProgress: [] });
  });

  it("egress gate: blocks the push when a second pass still finds a secret", () => {
    expect(egressGate(JSON.stringify(baseCard()))).toEqual({ ok: true });
    const leaked = JSON.stringify({ ...baseCard(), summary: "key AKIAIOSFODNN7EXAMPLE" });
    expect(egressGate(leaked)).toMatchObject({ ok: false, rules: ["aws_access_key"] });
  });

  it("fails closed: an internal error blocks the push instead of passing text through", () => {
    expect(() => redactText("x", { extraPatterns: ["(unclosed"] })).toThrow();
    expect(egressGate("{}", { extraPatterns: ["(unclosed"] })).toMatchObject({ ok: false });
    expect(egressGate("{}", { extraPatterns: ["a".repeat(500)] })).toMatchObject({ ok: false });
    expect(() => redactText(42 as unknown as string)).toThrow();
  });

  it("100% recall on fixtures/secrets/positive, <1% false positives on fixtures/secrets/negative", () => {
    const missed = corpus("positive").filter(({ text, rule }) => {
      const res = redactText(text);
      return !(rule in res.rules);
    });
    expect(missed).toEqual([]);
    const negatives = corpus("negative");
    const falsePositives = negatives.filter(({ text }) => redactText(text).count > 0);
    expect(falsePositives.map((f) => [f.file, f.text, redactText(f.text).text])).toEqual([]);
    expect(negatives.length).toBeGreaterThan(30);
  });

  it("stays linear on pathological input (no catastrophic backtracking)", () => {
    const inputs = [
      "a".repeat(200_000),
      `${"a.".repeat(50_000)}@`,
      `${"x".repeat(100_000)}@${"b-".repeat(50_000)}`,
      `api_key=${"z".repeat(100_000)}`,
      `-----BEGIN PRIVATE KEY-----${"Q".repeat(100_000)}`,
      "1.".repeat(100_000),
      `https://${"u".repeat(50_000)}:${"p".repeat(50_000)}`,
    ];
    for (const input of inputs) {
      const start = performance.now();
      redactText(input);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });

  it("no secret-rule hits on the prose of a real (anonymized) transcript", () => {
    const lines = readFileSync(
      new URL("../../../../fixtures/transcripts/cc-2.1.321-scaffold.jsonl", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    const texts: string[] = [];
    for (const l of lines) {
      const content = JSON.parse(l).message?.content;
      if (typeof content === "string") texts.push(content);
      else if (Array.isArray(content)) {
        for (const b of content) if (b.type === "text") texts.push(b.text);
      }
    }
    const PII = new Set(["email", "home_path", "phone", "ipv4"]);
    const hits = texts.filter((t) =>
      Object.keys(redactText(t).rules).some((rule) => !PII.has(rule)),
    );
    expect(texts.length).toBeGreaterThan(20);
    expect(hits.length / texts.length).toBeLessThan(0.01);
  });
});

// Regressions from the security review of the v1 engine (each input bypassed it).
describe("redact: security review regressions", () => {
  const blocked = (payload: unknown, config = {}) =>
    egressGate(JSON.stringify(payload), config).ok === false;

  it("egress gate decodes JSON strings, so escapes can't glue a letter onto a secret", () => {
    expect(blocked({ t: "x\nAKIAIOSFODNN7EXAMPLE" })).toBe(true);
    expect(blocked({ t: `a\tsk-ant-api03-${"Ab3-".repeat(8)}` })).toBe(true);
    expect(blocked({ t: 'password="abcdefghijk"' })).toBe(true);
    expect(blocked({ p: "C:\\Users\\alice\\x" })).toBe(true);
    expect(egressGate("not json")).toMatchObject({
      ok: false,
      reason: "payload is not valid JSON",
    });
  });

  it("only a complete tag vetoes the keyword rule (no forged [REDACTED prefix)", () => {
    expect(r("password=[REDACTED]hunter2hunter2xyz")).toBe("password=[REDACTED:secret_assignment]");
    expect(r("password=[REDACTED:email]")).toBe("password=[REDACTED:email]");
  });

  it("allowlist entries protect whole tokens only and must be ≥8 chars", () => {
    const tok = `ghp_${"A1".repeat(18)}`;
    expect(redactText(tok, { allowlist: ["ghp_"] }).text).toBe("[REDACTED:github_pat]");
    expect(redactText(tok, { allowlist: ["ghp_A1A1A1A1"] }).text).toBe("[REDACTED:github_pat]");
    expect(redactText(`use ${tok} now`, { allowlist: [tok] }).text).toBe(`use ${tok} now`);
  });

  it("rejects team patterns that could backtrack catastrophically or match nothing", () => {
    const evil = [
      "(a+)+$",
      "(a|a)*",
      "(\\w{2,})+x",
      "(x)\\1",
      "a*",
      "(?:)",
      "((a+))+$",
      "(?:(?:a+))+$",
      "a+a+a+a+$",
      "\\w+\\w+$",
      "x{1,100}y{1,100}$",
    ];
    for (const p of evil) {
      const start = performance.now();
      expect(() => redactText(`${"a".repeat(40)}!`, { extraPatterns: [p] })).toThrow();
      expect(performance.now() - start).toBeLessThan(100);
    }
    expect(redactText("ACME-12", { extraPatterns: ["ACME-\\d+"] }).text).toBe("[REDACTED:custom]");
    // Quantifier characters inside a class or escaped are literals, not quantifiers.
    expect(redactText("id corp_+*x", { extraPatterns: ["corp_[+*]\\*?x+"] }).text).toBe(
      "id [REDACTED:custom]",
    );
    // An allowed single-quantifier pattern stays fast on the largest input it ever sees.
    const start = performance.now();
    redactText(`${"a".repeat(4096)}!`, { extraPatterns: ["\\w+$"] });
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("egress gate doesn't read one field as context for another", () => {
    const sha = "a94a8fe5ccb19ba61c4c0873d391e987982fbbd3";
    for (const branch of ["feat/auth", "fix-token"]) {
      expect(egressGate(JSON.stringify({ git: { branch, head: sha } }))).toEqual({ ok: true });
    }
  });

  it("known secret prefixes are never mistaken for code after a keyword", () => {
    expect(r("API_KEY: sk_abcdefghij")).toBe("API_KEY: [REDACTED:secret_assignment]");
  });

  it("captures quoted values with spaces; skips bare values that read as code", () => {
    expect(r("export SECRET='my pass word here'")).toBe(
      "export SECRET='[REDACTED:secret_assignment]'",
    );
    expect(r("tokenizer: createTokenizerInstance")).toBe("tokenizer: createTokenizerInstance");
    expect(r("token: process.env.GH_TOKEN")).toBe("token: process.env.GH_TOKEN");
  });

  it("URL credentials: passwords containing @ are fully removed; scoped package URLs are left alone", () => {
    expect(r("postgres://user:p@ss@host/db")).toBe("postgres://[REDACTED:url_credentials]@host/db");
    expect(r("https://registry.npmjs.org:443/@als/core")).toBe(
      "https://registry.npmjs.org:443/@als/core",
    );
  });

  it("prefixed formats match after an underscore (GITHUB_TOKEN_ghp_…, my_sk_live_…)", () => {
    expect(r(`GITHUB_TOKEN_ghp_${"A1".repeat(18)}`)).toBe("GITHUB_TOKEN_[REDACTED:github_pat]");
    expect(r(`my_sk_live_${"EXAMPLEKEY".repeat(3)}`)).toBe("my_[REDACTED:stripe_key]");
  });

  it("covers Basic auth, Slack webhooks, and AWS secret keys next to an aws keyword", () => {
    expect(r("Authorization: Basic dXNlcjpwYXNzd29yZA==")).toBe(
      "Authorization: Basic [REDACTED:basic_auth]",
    );
    expect(r("Basic usage of the tool")).toBe("Basic usage of the tool");
    expect(r("https://hooks.slack.com/services/T0/B0/EXAMPLE")).toBe("[REDACTED:slack_webhook]");
    expect(r("aws secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")).toBe(
      "aws secret [REDACTED:high_entropy]",
    );
  });

  it("strips zero-width characters that would split a secret", () => {
    expect(r(`ghp_${"A1".repeat(9)}\u200b${"A1".repeat(9)}`)).toBe("[REDACTED:github_pat]");
  });

  it("path suppression needs a known extension; dotted versions aren't IPs", () => {
    expect(r("a/Xd5rJ2A8lSOxB1nOg9bu22k90geNkMwikEx7f0wQ.Next")).toBe(
      "[REDACTED:high_entropy].Next",
    );
    expect(r("version 20.11.1.0 and v1.2.3.4")).toBe("version 20.11.1.0 and v1.2.3.4");
  });
});
