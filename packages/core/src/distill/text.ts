// Prompt-text heuristics for the Tier-1 intent field — docs/ARCHITECTURE.md §2.2.

/**
 * Blocks the harness injects into user-role text. The whole block goes,
 * content included: none of it is something the human typed as a request.
 */
const INJECTED_BLOCKS = [
  "system-reminder",
  "command-name",
  "command-message",
  "local-command-stdout",
  "local-command-stderr",
  "local-command-caveat",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "pasted_content",
  "pasted-content",
  "user-memory-input",
  "task-notification",
];
const INJECTED_RE = new RegExp(
  `<(${INJECTED_BLOCKS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*?</\\1>`,
  "gi",
);
/** An opening tag that never closes (truncated paste): drop it and everything after. */
const UNCLOSED_RE = new RegExp(`<(?:${INJECTED_BLOCKS.join("|")})(?:\\s[^>]*)?>[\\s\\S]*$`, "i");
/** Stray closing tags. */
const STRAY_CLOSE_RE = new RegExp(`</(?:${INJECTED_BLOCKS.join("|")})>`, "gi");
/** Slash-command args are what the user actually typed: keep the text, drop the tags. */
const COMMAND_ARGS_RE = /<\/?command-args>/gi;

/** Messages the host app writes into the user turn. */
const HARNESS_TEXT = [
  /^The app was quit while you were working\b/i,
  /^Please continue from where you left off\b/i,
  /^\[Request interrupted by user/i,
];

/**
 * A session started by another session opens with a fixed preamble; the
 * actual request follows the "Task:" line.
 */
const HANDOFF_PREAMBLE = /^Background \(from the session that started this one\):/;

export function cleanPrompt(text: string): string {
  let out = text
    .replace(INJECTED_RE, " ")
    .replace(UNCLOSED_RE, " ")
    .replace(STRAY_CLOSE_RE, " ")
    .replace(COMMAND_ARGS_RE, "");
  out = out.trim();
  if (HANDOFF_PREAMBLE.test(out)) {
    const task = out.match(/\n\s*Task:\s*\n([\s\S]*)/);
    if (task?.[1]) out = task[1].trim();
  }
  return out;
}

const ACK_RE = /^(yes|ok|okay|continue|go|y)\b/i;
export const MIN_INTENT_CHARS = 20;

/** Worth considering as intent: not an acknowledgement, not harness noise, long enough. */
export function isSubstantive(cleaned: string): boolean {
  if (cleaned.length < MIN_INTENT_CHARS) return false;
  if (ACK_RE.test(cleaned)) return false;
  return !HARNESS_TEXT.some((re) => re.test(cleaned));
}

/**
 * First sentence of the first line that reads like prose: skips markdown
 * headings and label lines ending in ":".
 */
export function firstSentence(text: string): string {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*>]|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#") && !l.endsWith(":")) ?? lines[0] ?? "";
  const m = line.match(/^.*?[.!?](?=\s|$)/);
  return (m ? m[0] : line).replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(
  (
    "this that with from have what when where which would could should there their them they " +
    "then than into onto your yours about also just like make made need want please thanks " +
    "will been being were does done doing some more most other only over very each such here " +
    "file files code using used know think right going lets okay sure"
  ).split(" "),
);

/** Lower-cased content words (≥4 chars, not stopwords). */
export function contentWords(text: string): Set<string> {
  const words = new Set<string>();
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 4 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) words.add(w);
  }
  return words;
}

/** Minimum content words before a prompt can count as a new topic. */
const NEW_TOPIC_MIN_WORDS = 6;
/** Max share of the prompt's words already in the session vocabulary. */
const NEW_TOPIC_MAX_OVERLAP = 0.15;

/**
 * A later prompt starts a new topic when it's long enough to stand alone and
 * shares almost no vocabulary with the session so far (intent prompt,
 * follow-up prompts on that topic, edited file paths).
 */
export function isNewTopic(candidate: string, vocabulary: ReadonlySet<string>): boolean {
  const words = contentWords(candidate);
  if (words.size < NEW_TOPIC_MIN_WORDS) return false;
  let shared = 0;
  for (const w of words) if (vocabulary.has(w)) shared++;
  return shared / words.size < NEW_TOPIC_MAX_OVERLAP;
}

/** Truncate to `max` UTF-16 units with an ellipsis, without splitting a surrogate pair. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = max - 1;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return `${text.slice(0, cut).trimEnd()}…`;
}
