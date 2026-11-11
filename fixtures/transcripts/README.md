# Transcript fixtures

Claude Code JSONL transcripts used as golden inputs for the tailer, adapter and Tier-1 extractor (docs/ARCHITECTURE.md §2.1–2.2).

Source: `~/.claude/projects/<cwd-slug>/<sessionId>.jsonl` from your own sessions. Building this project with Claude Code produces plenty.

Before committing a transcript:

- **Anonymize it.** Replace home paths (`/Users/<name>/`), emails, usernames and hostnames. Remove any token, key or `.env` content, even fake ones; those belong in `fixtures/secrets/`.
- **Trim it** to the lines the test needs. Keep the entry types you want to cover: `user`, `assistant` with `tool_use`/`tool_result`, `attachment`, `summary`, sidechain lines, and partial or oversized lines for edge cases.
- **Pair it** with the expected output (`<name>.expected.json`) so it works as a golden test.
- Expect the format to drift between Claude Code versions. Note the version that produced each fixture in its filename or a sibling `.md`.

## Fixtures

| File                        | Source                                                                                                                   | Covers                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cc-2.1.321-scaffold.jsonl` | Real desktop-app session (Claude Code 2.1.321) that scaffolded this repo, run through `scripts/anonymize-transcript.mjs` | Real entry-type mix, `Edit`/`Write`, the desktop plan tool, hook-denied tool errors, one sample of every non-message entry type                                                                                    |
| `synthetic-cli.jsonl`       | Hand-built (CLI-shaped)                                                                                                  | `TodoWrite`, injected `<system-reminder>`, sidechain prompt + edit, `als-mcp` echo, 3× `Bash` errors, path outside the repo, relative path, unknown entry type, malformed line, acknowledgement prompt, `end_turn` |

Regenerate a real fixture with:

```bash
node scripts/anonymize-transcript.mjs <in.jsonl> <out.jsonl> --home /Users/<you> --user <you> --name "<Full Name>" --session <fake-uuid>
```

Then grep the output for your name, username, email and `/Users/` before committing.
