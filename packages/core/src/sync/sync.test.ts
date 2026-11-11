import { describe, it } from "vitest";

// Work queue for the sync layer — docs/ARCHITECTURE.md §2.4.
// Backlog: turn each todo into a real test using the in-memory transport
// and an injected clock, then implement.

describe("sync: Publisher — when to push", () => {
  it.todo("does not push when the semantic hash (card minus updatedAt/seq) is unchanged");
  it.todo("pushes 10s after the last HIGH event (trailing debounce)");
  it.todo("pushes at most 60s after the first unpushed MED+ event (max-wait)");
  it.todo("never pushes more often than every 15s");
  it.todo("sends a heartbeat push after 10 min with no push while active");
});

describe("sync: Publisher — writes and seq", () => {
  it.todo("increments seq on every push");
  it.todo("on startup, recovers seq from the remote card (seq = remote.seq + 1)");
  it.todo("passes the last known blob sha as a compare-and-swap guard");
  it.todo("on conflict, refetches its own blob sha and retries with jittered backoff (max 4)");
  it.todo("queues only the latest card while offline and flushes it on reconnect");
  it.todo("switches to read-only mode when the token cannot push");
});

describe("sync: Poller", () => {
  it.todo("sends If-None-Match and does nothing on 304");
  it.todo("on a new head, fetches the tree and only the blobs whose sha changed");
  it.todo("polls every 10s when focused or a local agent is active, 30s otherwise");
  it.todo("slows to 120s when rate-limit remaining drops below 10%");
  it.todo("honors retry-after on 403/429 secondary rate limits");
  it.todo("adds ±20% jitter to the interval");
});

describe("sync: Merger", () => {
  it.todo("accepts a card only if its seq is greater than the cached seq for that agent");
  it.todo("converges to each writer's last seq under random latency, drops and reordering");
  it.todo("picks the same claim winner on every reader: earliest since, then lexical agentId");
  it.todo("marks agents stale from age (server Date header), not self-reported status");
  it.todo("re-pushes its own card when the remote copy differs from the last push");
});
