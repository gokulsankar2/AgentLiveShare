// Redaction rules — docs/ARCHITECTURE.md §2.3.
// Known-format patterns are a subset of the gitleaks rules (MIT), tightened
// where noted. Every pattern that starts with a repeated character class is
// anchored with a lookbehind so a long run of non-matching text is scanned in
// linear time (no O(n²) retries from every start position).

export interface Rule {
  id: string;
  re: RegExp;
  /**
   * Builds the replacement. Return `match` unchanged to veto a hit. Default:
   * the whole match becomes `[REDACTED:<id>]`.
   */
  replace?: (tag: string, match: string, groups: string[]) => string;
}

export const tag = (id: string) => `[REDACTED:${id}]`;
/** A complete redaction tag, and nothing else. */
export const TAG_RE = /^\[REDACTED:[a-z0-9_]+\]$/;

// Lookbehinds exclude letters/digits only (not `_`): the prefixes below are
// distinctive enough that `GITHUB_TOKEN_ghp_…` or `my_sk_live_…` must still match.

/** Layer 1: known secret formats (high precision). Order matters: specific before generic. */
export const KNOWN_FORMAT_RULES: readonly Rule[] = [
  {
    id: "private_key",
    // Unterminated blocks (a truncated paste) are redacted to end of text.
    re: /-----BEGIN[A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  { id: "aws_access_key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g },
  { id: "github_pat", re: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,255}(?![A-Za-z0-9])/g },
  { id: "github_pat", re: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,255}/g },
  { id: "gitlab_pat", re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g },
  { id: "npm_token", re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { id: "anthropic_key", re: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: "openai_key",
    // Requires a digit so kebab-case identifiers ("sk-some-long-name-here") don't match.
    re: /(?<![A-Za-z0-9-])sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  },
  { id: "slack_token", re: /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "slack_webhook", re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { id: "stripe_key", re: /(?<![A-Za-z0-9])[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { id: "google_api_key", re: /(?<![A-Za-z0-9])AIza[A-Za-z0-9_-]{35}/g },
  {
    id: "jwt",
    re: /(?<![A-Za-z0-9-])eyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  },
  {
    id: "url_credentials",
    // The password may contain "@": take the last "@" that is followed by a
    // host. A "/" ends the userinfo, so "https://host:443/@scope/pkg" is left alone.
    re: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s/@]*(?:@[^\s/@]*)*?@(?=[A-Za-z0-9.-]+(?:[:/?#\s"'\])]|$))/g,
    replace: (t, _m, [scheme]) => `${scheme}${t}@`,
  },
  {
    id: "bearer_token",
    re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi,
    replace: (t, _m, [prefix]) => `${prefix}${t}`,
  },
  {
    id: "basic_auth",
    // Base64 credentials always contain a digit, "+", "/" or "=" in practice; plain words don't.
    re: /\b(Basic\s+)(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g,
    replace: (t, _m, [prefix]) => `${prefix}${t}`,
  },
];

/** Values that follow a secret-ish key but are obviously not secrets. */
const BENIGN_VALUES = new Set([
  "required",
  "optional",
  "undefined",
  "nullable",
  "boolean",
  "string",
  "number",
  "redacted",
]);

/**
 * Bare values that read as code, not credentials: multi-word camelCase or
 * snake_case identifiers and env-var references (`tokenizer: createTokenizer`,
 * `token: process.env.GH_TOKEN`). Without this the egress gate would block
 * any card that quotes code. Trade-off: a password written as a camelCase
 * phrase isn't caught here (nor by the entropy layer).
 */
function looksLikeCode(value: string): boolean {
  if (/^(?:sk|rk|pk|ghp|gho|ghu|ghs|ghr|xox[a-z]|glpat|npm|whsec|key)[-_]/i.test(value))
    return false;
  return (
    /^[a-z]+(?:[A-Z][a-z]+)+(?:\(\))?[,;]?$/.test(value) ||
    /^[a-z]+(?:_[a-z]+)+$/.test(value) ||
    /^(?:process\.env\.|os\.environ|\$\{?[A-Z_])/.test(value)
  );
}

/**
 * Layer 2: `<secret-ish key> = value`. The key name stays, only the value goes.
 * - A closing quote after the key is accepted, so JSON (`"apiKey": "…"`) matches.
 * - No left boundary, so camelCase keys (`clientSecret`, `dbPassword`) match.
 * - Quoted values are taken up to the closing quote (spaces included, ≥4
 *   chars); bare values need ≥8 chars (spec).
 */
export const KEYWORD_RULE: Rule = {
  id: "secret_assignment",
  re: /((?:api[_-]?key|secret|token|passw(?:or)?d|pwd|auth(?!or(?:s|ed|ing|ship)?\b)|credential|private[_-]?key|access[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*)(?:"([^"\n]{4,500})"|'([^'\n]{4,500})'|([^\s"']{8,}))/gi,
  replace: (t, match, [prefix = "", dq = "", sq = "", bare = ""]) => {
    const value = dq || sq || bare;
    if (TAG_RE.test(value) || BENIGN_VALUES.has(value.toLowerCase())) return match;
    if (bare && looksLikeCode(bare)) return match;
    if (dq) return `${prefix}"${t}"`;
    if (sq) return `${prefix}'${t}'`;
    return `${prefix}${t}`;
  },
};

/** Keyword used to un-suppress SHA-shaped tokens and for context checks. */
export const SECRET_KEYWORD =
  /api[_-]?key|secret|token|passw(?:or)?d|auth(?!or(?:s|ed|ing|ship)?\b)|credential/i;

/** Layer 4: PII. */
export const PII_RULES: readonly Rule[] = [
  {
    id: "email",
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
  },
  { id: "phone", re: /(?<![\w+])\+[1-9]\d{7,14}(?!\d)/g },
  { id: "phone", re: /(?<![\w(])\(?\d{3}\)?[-.\s]\d{3}[-.]\d{4}(?![\w])/g },
  {
    id: "home_path",
    re: /(?:\/Users|\/home)\/[^/\s"'`]+(?=\/)/g,
    replace: () => "~",
  },
  {
    id: "home_path",
    re: /\b[A-Za-z]:\\Users\\[^\\\s"'`]+(?=\\)/g,
    replace: () => "~",
  },
  {
    id: "ipv4",
    // Dotted version numbers ("v1.2.3.4", "version 20.11.1.0") are not addresses.
    re: /(?<![\d.])(?<!\bv)(?<!\bversion\s{0,3})(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/gi,
    replace: (t, ip) => (isPrivateIPv4(ip) ? ip : t),
  },
];

export function isPrivateIPv4(ip: string): boolean {
  const [a = -1, b = -1] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}
