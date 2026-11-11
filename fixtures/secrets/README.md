# Secret fixtures

Corpus for the redaction engine tests (docs/ARCHITECTURE.md §2.3).

- `positive/`: strings that **must** be redacted. One case per file or line, grouped by rule.
- `negative/`: strings that must **not** be redacted: git SHAs, UUIDs, `sha512-` integrity hashes, file paths, minified identifiers, lockfile content.

Rules:

- **Fake values only.** Use the vendor-published example values (e.g. `AKIAIOSFODNN7EXAMPLE`) or strings you generate that match the format. Never paste a real key, even a revoked one.
- Keep each case small and labelled with the rule it exercises, so a recall failure points at one regex.
- GitHub push protection and secret scanners may flag realistic fakes. Prefer obviously fake bodies (`EXAMPLE`, repeated characters) where the format allows.

## Layout

- `positive/<rule>.txt`: one case per line, `#` lines are comments, a literal `\n` is unescaped to a newline (for PEM blocks), and `<split>` is removed. Use `<split>` inside any fake value that GitHub push protection matches by shape (Stripe keys today), so the file never holds the whole string. The file name is the rule id that must fire: `redact.test.ts` asserts 100% recall per rule.
- `negative/<category>.txt`: same format. Every line must produce zero redactions.
- The `high_entropy` and `integrity` random values were generated once with `crypto.randomBytes` and are not real credentials.
