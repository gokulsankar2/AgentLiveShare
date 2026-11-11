// Minimal gitignore-style glob matching for neverSyncPaths (§2.3 layer 5).
// `**` spans directories, `*` and `?` stay within one segment. A pattern with
// no `/` matches the basename at any depth (".env*" matches "app/.env.local").

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Case-insensitive (`.ENV` is still a secret file), backslashes count as
 * separators, and a pattern also matches as a directory prefix
 * (`secrets` and `secrets/` both cover `secrets/prod/db.txt`).
 */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  const clean = path.replaceAll("\\", "/").replace(/^\.?\//, "");
  const segments = clean.split("/");
  return globs.some((g) => {
    const pattern = g
      .replaceAll("\\", "/")
      .replace(/^\.?\//, "")
      .replace(/\/+$/, "");
    if (!pattern) return false;
    const re = new RegExp(globToRegExp(pattern).source, "i");
    if (!pattern.includes("/")) return segments.some((s) => re.test(s));
    // Anchored pattern: the path itself or any ancestor directory may match.
    return segments.some((_, i) => re.test(segments.slice(0, i + 1).join("/")));
  });
}
