function tokenizePath(path: string): Array<string | number | "[]"> {
  const tokens: Array<string | number | "[]"> = [];
  const matcher = /(\[\])|([^.[\]]+)|(\[(\d+)\])/g;

  for (const match of path.matchAll(matcher)) {
    if (match[1]) {
      tokens.push("[]");
      continue;
    }
    if (match[2]) {
      tokens.push(match[2]);
      continue;
    }
    if (match[4]) {
      tokens.push(Number(match[4]));
    }
  }

  return tokens;
}

export function getByPath(obj: unknown, path: string): unknown {
  if (!path) {
    return obj;
  }

  const tokens = tokenizePath(path);
  let current: unknown = obj;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (current === null || current === undefined) {
      return undefined;
    }

    if (token === "[]") {
      // Array spread marker. If current is already a single item
      // (List iteration unwrapped it), just skip. If current is still
      // an array, map remaining path over each element.
      if (Array.isArray(current)) {
        const remainingTokens = tokens.slice(i + 1);
        if (remainingTokens.length === 0) continue;
        const remainingPath = remainingTokens
          .map((t) => (typeof t === "number" ? `[${t}]` : t === "[]" ? "[]" : `.${t}`))
          .join("")
          .replace(/^\./, "");
        return current.map((item) => getByPath(item, remainingPath));
      }
      continue;
    }

    if (typeof token === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[token];
      continue;
    }

    if (typeof current !== "object") {
      return undefined;
    }

    current = (current as Record<string, unknown>)[token];
  }

  return current;
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectPaths(
  value: unknown,
  basePath: string,
  paths: string[],
  depth: number,
  maxDepth: number,
) {
  if (depth > maxDepth) {
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const nextPath = `${basePath}[${index}]`;
      paths.push(nextPath);
      collectPaths(value[index], nextPath, paths, depth + 1, maxDepth);
    }
    return;
  }

  if (isObjectLike(value)) {
    for (const [key, child] of Object.entries(value)) {
      const nextPath = basePath ? `${basePath}.${key}` : key;
      paths.push(nextPath);
      collectPaths(child, nextPath, paths, depth + 1, maxDepth);
    }
  }
}

export function enumeratePaths(obj: unknown, maxDepth = 8): string[] {
  const paths: string[] = [];
  collectPaths(obj, "", paths, 0, maxDepth);
  return paths;
}

export function formatPathForDisplay(path: string): string {
  if (!path) {
    return "(root)";
  }

  return path
    .replace(/\[\]/g, " -> [each]")
    .replace(/\./g, " -> ")
    .replace(/\[(\d+)\]/g, " -> [$1]")
    .replace(/^ -> /, "");
}
