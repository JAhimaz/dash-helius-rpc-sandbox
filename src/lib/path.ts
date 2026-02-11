function tokenizePath(path: string): Array<string | number> {
  const tokens: Array<string | number> = [];
  const matcher = /([^.[\]]+)|(\[(\d+)\])/g;

  for (const match of path.matchAll(matcher)) {
    if (match[1]) {
      tokens.push(match[1]);
      continue;
    }
    if (match[3]) {
      tokens.push(Number(match[3]));
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

  for (const token of tokens) {
    if (current === null || current === undefined) {
      return undefined;
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
    .replace(/\./g, " -> ")
    .replace(/\[(\d+)\]/g, " -> [$1]")
    .replace(/^ -> /, "");
}
