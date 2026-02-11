import { load, type Cheerio, type CheerioAPI } from "cheerio";
import { writeFile } from "node:fs/promises";
import type { AnyNode } from "domhandler";

import type {
  JsonExampleSchema,
  MethodRegistryEntry,
  MethodRegistryFile,
  StructuredField,
  StructuredSchema,
} from "../src/lib/methodRegistry";

const ROOT_URL = "https://www.helius.dev/docs/api-reference/rpc/http-methods";
const RPC_PATH_PREFIX = "/docs/api-reference/rpc/http-methods";
const OUTPUT_PATH = "src/lib/generatedMethodRegistry.json";

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "helius-flow-method-registry-generator/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

function normalizeUrl(href: string, baseUrl: string): string | null {
  try {
    const next = new URL(href, baseUrl);
    if (next.origin !== "https://www.helius.dev") {
      return null;
    }
    if (!next.pathname.startsWith(RPC_PATH_PREFIX)) {
      return null;
    }
    next.hash = "";
    return next.toString();
  } catch {
    return null;
  }
}

function textOf(element: Cheerio<AnyNode>): string {
  return element
    .text()
    .replace(/\s+/g, " ")
    .trim();
}

function extractLinks(html: string, pageUrl: string): string[] {
  const $ = load(html);
  const links = new Set<string>();

  $("a[href]").each((_idx: number, node: AnyNode) => {
    const href = $(node).attr("href");
    if (!href) {
      return;
    }
    const normalized = normalizeUrl(href, pageUrl);
    if (!normalized) {
      return;
    }
    links.add(normalized);
  });

  return Array.from(links);
}

function tableToFields($: CheerioAPI, table: Cheerio<AnyNode>): StructuredField[] {
  const headers = table
    .find("thead th")
    .toArray()
    .map((cell: AnyNode) => textOf($(cell)).toLowerCase());

  const rows = table.find("tbody tr").toArray();
  const fields: StructuredField[] = [];

  for (const row of rows) {
    const cols = $(row)
      .find("td")
      .toArray()
      .map((cell: AnyNode) => textOf($(cell)));

    if (!cols.length) {
      continue;
    }

    const nameIndex = headers.findIndex((header) => header.includes("name") || header.includes("param"));
    const typeIndex = headers.findIndex((header) => header.includes("type"));
    const requiredIndex = headers.findIndex((header) => header.includes("required"));
    const descriptionIndex = headers.findIndex((header) => header.includes("description") || header.includes("details"));

    const name = cols[nameIndex >= 0 ? nameIndex : 0]?.trim();
    if (!name) {
      continue;
    }

    const requiredText = cols[requiredIndex >= 0 ? requiredIndex : -1]?.toLowerCase();
    const required =
      requiredText === undefined
        ? undefined
        : requiredText.includes("yes") || requiredText.includes("required") || requiredText === "true";

    fields.push({
      name,
      type: typeIndex >= 0 ? cols[typeIndex] : undefined,
      required,
      description: descriptionIndex >= 0 ? cols[descriptionIndex] : undefined,
    });
  }

  return fields;
}

function maybeParseJsonBlock(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractJsonExample($: CheerioAPI, scope: Cheerio<AnyNode>): JsonExampleSchema | undefined {
  const codeBlocks = scope.find("pre code").toArray();
  for (const block of codeBlocks) {
    const parsed = maybeParseJsonBlock($(block).text());
    if (parsed !== null) {
      return { kind: "json_example", value: parsed };
    }
  }
  return undefined;
}

function findSectionSchema($: CheerioAPI, matchers: RegExp[]): StructuredSchema | undefined {
  const headings = $("h1, h2, h3, h4, h5").toArray();

  for (const heading of headings) {
    const label = textOf($(heading));
    if (!matchers.some((matcher) => matcher.test(label))) {
      continue;
    }

    const collected: Cheerio<AnyNode>[] = [];
    let cursor = $(heading).next();

    while (cursor.length) {
      const tag = (cursor.get(0)?.tagName ?? "").toLowerCase();
      if (/^h[1-6]$/.test(tag)) {
        break;
      }
      collected.push(cursor);
      cursor = cursor.next();
    }

    for (const section of collected) {
      const table = section.find("table").first();
      if (table.length) {
        const fields = tableToFields($, table);
        if (fields.length > 0) {
          return {
            kind: "table",
            fields,
          };
        }
      }
    }

    for (const section of collected) {
      const maybeJson = extractJsonExample($, section);
      if (maybeJson) {
        return maybeJson;
      }
    }
  }

  return undefined;
}

function extractMethodName(html: string): string | undefined {
  const $ = load(html);

  const codeBlocks = $("pre code").toArray();
  for (const block of codeBlocks) {
    const text = $(block).text();
    const match = text.match(/"method"\s*:\s*"([a-zA-Z0-9_]+)"/);
    if (match?.[1]) {
      return match[1];
    }
  }

  const h1 = textOf($("h1").first());
  if (/^[a-zA-Z][a-zA-Z0-9_]+$/.test(h1)) {
    return h1;
  }

  return undefined;
}

function buildUnknownEntry(method: string, docsUrl: string): MethodRegistryEntry {
  return {
    method,
    docsUrl,
    schema: "unknown",
  };
}

function parsePage(pageUrl: string, html: string): MethodRegistryEntry | undefined {
  const method = extractMethodName(html);
  if (!method) {
    return undefined;
  }

  const $ = load(html);
  const params = findSectionSchema($, [/params?/i, /parameters?/i, /request body/i]);
  const response = findSectionSchema($, [/response/i, /result/i, /output/i]);

  if (!params && !response) {
    return buildUnknownEntry(method, pageUrl);
  }

  return {
    method,
    docsUrl: pageUrl,
    schema: "known",
    params,
    response,
  };
}

function mergeEntry(target: MethodRegistryEntry, candidate: MethodRegistryEntry): MethodRegistryEntry {
  if (target.schema === "unknown" && candidate.schema === "known") {
    return candidate;
  }

  if (target.schema === "known" && candidate.schema === "known") {
    return {
      ...target,
      params: target.params ?? candidate.params,
      response: target.response ?? candidate.response,
    };
  }

  return target;
}

async function crawlRpcDocs(): Promise<MethodRegistryEntry[]> {
  const queue: string[] = [ROOT_URL];
  const seen = new Set<string>();
  const byMethod = new Map<string, MethodRegistryEntry>();

  while (queue.length > 0) {
    const url = queue.shift();
    if (!url || seen.has(url)) {
      continue;
    }

    seen.add(url);

    try {
      const html = await fetchHtml(url);
      const entry = parsePage(url, html);
      if (entry) {
        const existing = byMethod.get(entry.method);
        byMethod.set(entry.method, existing ? mergeEntry(existing, entry) : entry);
      }

      const links = extractLinks(html, url);
      for (const link of links) {
        if (!seen.has(link)) {
          queue.push(link);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[gen:methods] ${message}`);
    }
  }

  return Array.from(byMethod.values()).sort((a, b) => a.method.localeCompare(b.method));
}

async function main() {
  const methods = await crawlRpcDocs();

  const payload: MethodRegistryFile = {
    sourceUrl: ROOT_URL,
    generatedAt: new Date().toISOString(),
    methods,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  console.log(`[gen:methods] wrote ${methods.length} methods to ${OUTPUT_PATH}`);
}

void main();
