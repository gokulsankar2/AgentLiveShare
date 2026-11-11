import { z } from "zod";

// Synced agent card: `.agents/sessions/<agentId>.json` on the `agent-sync` branch.
// Spec: docs/ARCHITECTURE.md §1.4. Field caps here are the hard limits; the
// Budgeter is responsible for keeping the serialized card under the byte budget.

export const SCHEMA_VERSION = 1;
export const TARGET_CARD_BYTES = 1024;
export const MAX_CARD_BYTES = 1536;

const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
// <githubLogin>--<first 8 hex chars of the Claude Code sessionId>
const AGENT_ID = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})--[0-9a-f]{8}$/;

const timestamp = z.iso.datetime({ offset: true });
const repoPath = z.string().min(1).max(200);

export const AgentStatus = z.enum(["active", "waiting_on_user", "idle", "ended"]);
export const TaskState = z.enum(["pending", "in_progress", "done"]);

export const Task = z.object({
  text: z.string().min(1).max(80),
  state: TaskState,
});

// `since` orders overlapping claims (earliest wins, then lexical agentId — §2.4);
// `until` is when the claim expires.
export const Claim = z
  .object({
    glob: repoPath,
    since: timestamp,
    until: timestamp,
  })
  .refine((c) => Date.parse(c.until) > Date.parse(c.since), {
    message: "claim.until must be after claim.since",
    path: ["until"],
  });

export const Note = z.object({
  to: z.union([z.literal("*"), z.string().regex(GITHUB_LOGIN)]),
  text: z.string().min(1).max(200),
  at: timestamp,
});

export const AgentCard = z.object({
  v: z.literal(SCHEMA_VERSION),
  agentId: z.string().regex(AGENT_ID),
  owner: z.object({ login: z.string().regex(GITHUB_LOGIN) }),
  tool: z.literal("claude-code"),
  seq: z.number().int().nonnegative(),
  updatedAt: timestamp,
  status: AgentStatus,
  git: z.object({
    branch: z.string().min(1).max(100),
    head: z.string().regex(/^[0-9a-f]{7,40}$/),
  }),
  intent: z.string().max(200),
  summary: z.string().max(400),
  tasks: z.array(Task).max(8),
  files: z.object({
    modified: z.array(repoPath).max(15),
    inProgress: z.array(repoPath).max(15),
  }),
  claims: z.array(Claim).max(5),
  decisions: z.array(z.string().min(1).max(120)).max(3),
  blockers: z.array(z.string().min(1).max(120)).max(3),
  notes: z.array(Note).max(3),
  meta: z.object({
    distillTier: z.union([z.literal(1), z.literal(2)]),
    redactions: z.number().int().nonnegative(),
    engine: z.string().min(1).max(20),
  }),
});

export type AgentStatus = z.infer<typeof AgentStatus>;
export type TaskState = z.infer<typeof TaskState>;
export type Task = z.infer<typeof Task>;
export type Claim = z.infer<typeof Claim>;
export type Note = z.infer<typeof Note>;
export type AgentCard = z.infer<typeof AgentCard>;

/** Byte length of the card exactly as it is pushed (compact JSON, UTF-8). */
export function serializedCardBytes(card: AgentCard): number {
  return Buffer.byteLength(JSON.stringify(card), "utf8");
}
