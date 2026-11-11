# Secret fixtures

Corpus for the redaction engine tests (docs/ARCHITECTURE.md §2.3).

- `positive/`: strings that **must** be redacted. One case per file or line, grouped by rule.
- `negative/`: strings that must **not** be redacted: git SHAs, UUIDs, `sha512-` integrity hashes, file paths, minified identifiers, lockfile content.

Rules:

- **Fake values only.** Use the vendor-published example values (e.g. `AKIAIOSFODNN7EXAMPLE`) or strings you generate that match the format. Never paste a real key, even a revoked one.
- Keep each case small and labelled with the rule it exercises, so a recall failure points at one regex.
- GitHub push protection and secret scanners may flag realistic fakes. Prefer obviously fake bodies (`EXAMPLE`, repeated characters) where the format allows.
