import { NextResponse } from "next/server";
import { getMethodEntries, getMethodEntry } from "@/lib/methodRegistry";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_BETA = "mcp-client-2025-11-20";
const HELIUS_MCP_SERVER_NAME = "helius-docs";
const HELIUS_MCP_URL = "https://docs.helius.dev/mcp";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";
const DEFAULT_PLANNER_MAX_TOKENS = 700;
const DEFAULT_REPAIR_MAX_TOKENS = 320;
const MODEL_ALIAS_MAP: Record<string, string> = {
  "claude-3-5-haiku-latest": "claude-3-5-haiku-20241022",
  "claude-3-5-sonnet-latest": "claude-3-5-sonnet-20241022",
  "claude-3-7-sonnet-latest": "claude-3-7-sonnet-20250219",
  "claude-sonnet-4-5": "claude-sonnet-4-20250514",
};

type ChatRole = "user" | "assistant";

interface ClientMessage {
  role: ChatRole;
  text: string;
}

interface ChatRequestBody {
  messages?: unknown;
  mode?: unknown;
}

interface AnthropicTextBlock {
  type?: string;
  text?: string;
}

interface AnthropicResponse {
  content?: AnthropicTextBlock[];
  stop_reason?: string;
  error?: {
    message?: string;
  };
}

interface ClaudeNodeProposal {
  localId?: string;
  method?: string;
  paramsByField?: Record<string, unknown>;
  rawParams?: unknown[];
}

interface ClaudeParsedPayload {
  reply?: string;
  proposedNode?: ClaudeNodeProposal | null;
  proposedNodes?: ClaudeNodeProposal[] | null;
}

interface ChatNodeProposal {
  localId?: string;
  method: string;
  paramsByField?: Record<string, unknown>;
  rawParams?: unknown[];
}

export const runtime = "nodejs";

function normalizeMessages(input: unknown): ClientMessage[] | null {
  if (!Array.isArray(input)) {
    return null;
  }

  const normalized = input
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) {
        return null;
      }

      const rawRole = (entry as { role?: unknown }).role;
      const rawText = (entry as { text?: unknown }).text;
      if ((rawRole !== "user" && rawRole !== "assistant") || typeof rawText !== "string") {
        return null;
      }

      const text = rawText.trim();
      if (!text) {
        return null;
      }

      return { role: rawRole, text } as ClientMessage;
    })
    .filter((entry): entry is ClientMessage => Boolean(entry));

  return normalized.length > 0 ? normalized : null;
}

function extractAssistantText(responseBody: AnthropicResponse): string {
  if (!Array.isArray(responseBody.content)) {
    return "";
  }

  return responseBody.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text?.trim() ?? "")
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function extractJsonObject(text: string): ClaudeParsedPayload | null {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    candidates.push(fenced[1].trim());
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ClaudeParsedPayload;
      if (typeof parsed === "object" && parsed !== null) {
        return parsed;
      }
    } catch {
      // Keep trying candidate variants.
    }
  }

  return null;
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeProposalInput(raw: unknown): ClaudeNodeProposal[] {
  if (Array.isArray(raw)) {
    return raw.filter((entry): entry is ClaudeNodeProposal => typeof entry === "object" && entry !== null);
  }

  if (raw && typeof raw === "object") {
    return [raw as ClaudeNodeProposal];
  }

  return [];
}

function parseMode(value: unknown): "plan" | "repair" {
  return value === "repair" ? "repair" : "plan";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeModelName(model: string): string {
  return MODEL_ALIAS_MAP[model] ?? model;
}

function scoreMethodForMessage(method: string, message: string): number {
  const methodLower = method.toLowerCase();
  const words = message.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let score = 0;

  for (const word of words) {
    if (word.length < 3) {
      continue;
    }
    if (methodLower.includes(word)) {
      score += 2;
    }
  }

  if (message.includes("balance") && methodLower.includes("balance")) {
    score += 4;
  }
  if ((message.includes("log") || message.includes("print") || message.includes("output")) && methodLower === "log output") {
    score += 4;
  }
  if (message.includes("airdrop") && methodLower.includes("airdrop")) {
    score += 4;
  }

  return score;
}

function chooseCandidateEntries(message: string, limit = 8) {
  const allEntries = getMethodEntries();
  if (!message.trim()) {
    return allEntries.slice(0, limit);
  }

  const lower = message.toLowerCase();

  const directMethods: string[] = [];
  if (/\bbalance\b/.test(lower)) {
    directMethods.push("getBalance");
  }
  if (/\blog\b|\bprint\b|\boutput\b/.test(lower)) {
    directMethods.push("Log Output");
  }
  if (/\bairdrop\b/.test(lower)) {
    directMethods.push("requestAirdrop");
  }

  const selected = new Map<string, (typeof allEntries)[number]>();
  for (const method of directMethods) {
    const entry = allEntries.find((candidate) => candidate.method === method);
    if (entry) {
      selected.set(entry.method, entry);
    }
  }

  const scored = allEntries
    .map((entry) => ({ entry, score: scoreMethodForMessage(entry.method, lower) }))
    .sort((a, b) => b.score - a.score || a.entry.method.localeCompare(b.entry.method));

  for (const candidate of scored) {
    if (selected.size >= limit) {
      break;
    }
    if (candidate.score <= 0 && selected.size > 0) {
      break;
    }
    selected.set(candidate.entry.method, candidate.entry);
  }

  if (selected.size === 0) {
    return allEntries.slice(0, limit);
  }

  return [...selected.values()].slice(0, limit);
}

function shouldUseMcp(message: string, mode: "plan" | "repair"): boolean {
  if (mode === "repair") {
    return false;
  }

  const lower = message.toLowerCase();
  if (/\bbalance\b/.test(lower) || /\blog\b|\bprint\b|\boutput\b/.test(lower) || /\bairdrop\b/.test(lower)) {
    return false;
  }

  return true;
}

function validateProposals(raw: unknown): {
  proposals: ChatNodeProposal[];
  canAddNodes: boolean;
  availabilityError?: string;
} {
  const rawProposals = normalizeProposalInput(raw);
  if (rawProposals.length === 0) {
    return {
      proposals: [],
      canAddNodes: false,
    };
  }

  const proposals: ChatNodeProposal[] = [];

  for (let index = 0; index < rawProposals.length; index += 1) {
    const rawProposal = rawProposals[index];
    const method = toNonEmptyString(rawProposal.method);
    if (!method) {
      return {
        proposals: [],
        canAddNodes: false,
        availabilityError: `Proposed node #${index + 1} is missing a valid method.`,
      };
    }

    const entry = getMethodEntry(method);
    if (!entry) {
      return {
        proposals: [],
        canAddNodes: false,
        availabilityError: `Method ${method} is not available in this workflow registry.`,
      };
    }

    const localId = toNonEmptyString(rawProposal.localId) ?? undefined;

    if (entry.params?.kind === "table") {
      const rawParamsByField = rawProposal.paramsByField;
      const input = rawParamsByField && typeof rawParamsByField === "object" ? rawParamsByField : {};
      const paramsByField: Record<string, unknown> = {};

      for (const field of entry.params.fields) {
        if (Object.prototype.hasOwnProperty.call(input, field.name)) {
          paramsByField[field.name] = (input as Record<string, unknown>)[field.name];
        }
      }

      const missingRequired = entry.params.fields
        .filter((field) => field.required)
        .filter((field) => !Object.prototype.hasOwnProperty.call(paramsByField, field.name))
        .map((field) => field.name);
      if (missingRequired.length > 0) {
        return {
          proposals: [],
          canAddNodes: false,
          availabilityError: `Method ${method} is missing required argument(s): ${missingRequired.join(", ")}`,
        };
      }

      proposals.push({
        localId,
        method,
        paramsByField,
      });
      continue;
    }

    const rawParams = Array.isArray(rawProposal.rawParams) ? rawProposal.rawParams : [];
    proposals.push({
      localId,
      method,
      rawParams,
    });
  }

  return {
    proposals,
    canAddNodes: proposals.length > 0,
  };
}

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing ANTHROPIC_API_KEY. Add it to your .env file and restart the server." },
      { status: 500 },
    );
  }

  let requestBody: ChatRequestBody;
  try {
    requestBody = (await request.json()) as ChatRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const messages = normalizeMessages(requestBody.messages);
  if (!messages) {
    return NextResponse.json({ error: "Provide a non-empty `messages` array." }, { status: 400 });
  }

  const mode = parseMode(requestBody.mode);
  const model =
    mode === "repair"
      ? process.env.ANTHROPIC_MODEL_REPAIR ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL
      : process.env.ANTHROPIC_MODEL_PLANNER ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
  const resolvedModel = normalizeModelName(model);
  const maxTokens =
    mode === "repair"
      ? parsePositiveInt(process.env.ANTHROPIC_MAX_TOKENS_REPAIR, DEFAULT_REPAIR_MAX_TOKENS)
      : parsePositiveInt(process.env.ANTHROPIC_MAX_TOKENS_PLANNER, DEFAULT_PLANNER_MAX_TOKENS);

  const lastUserMessage =
    [...messages]
      .reverse()
      .find((message) => message.role === "user")
      ?.text ?? "";
  const candidateEntries = chooseCandidateEntries(lastUserMessage);
  const candidateMethodNames = candidateEntries.map((entry) => entry.method);
  const candidateCatalog = candidateEntries.map((entry) => ({
    method: entry.method,
    schema: entry.schema,
    params:
      entry.params?.kind === "table"
        ? entry.params.fields.map((field) => ({
            name: field.name,
            required: Boolean(field.required),
            type: field.type ?? "unknown",
          }))
        : "rawParams",
  }));
  const useMcp = shouldUseMcp(lastUserMessage, mode);
  const systemPrompt = `You are a helpful assistant for building Solana workflows.
${useMcp ? "Use Helius MCP tools when needed to disambiguate methods." : "Use only the local available methods below."}

You must respond with JSON only, with this shape:
{
  "reply": "human-readable explanation including selected RPC method(s) and arguments",
  "proposedNodes": [
    {
      "localId": "optional short id for cross-node references",
      "method": "exact method string",
      "paramsByField": { "fieldName": "value or ref object" },
      "rawParams": []
    }
  ] | null
}

Reference object format for table params:
{ "type": "ref", "fromNodeIndex": 0, "path": "result.value" }

Rules:
- Set "proposedNodes" to null unless the user asks to create/add/build workflow nodes.
- For multi-step goals, include all required nodes in execution order in "proposedNodes".
- Keep "reply" clear and concise (max 2 short sentences).
- If method schema is table-style, use "paramsByField" and omit "rawParams".
- If method schema is unknown/raw, use "rawParams" as an array and omit "paramsByField".
- Each node's "method" must be one of the candidate methods below.
- For getTokenAccountsByOwnerV2, if "programId" is provided, use exactly "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" unless the user explicitly asks for a different valid program.
- For getTokenAccountsByOwnerV2, default "encoding" to "base64" unless the user explicitly requests another encoding.
- Do not include markdown fences or extra text outside JSON.

Candidate methods:
${JSON.stringify(candidateMethodNames)}

Candidate method details:
${JSON.stringify(candidateCatalog)}`;

  const toAnthropicMessages = (inputMessages: ClientMessage[]) =>
    inputMessages.map((message) => ({
      role: message.role,
      content: message.text,
    }));

  try {
    const sendAnthropicRequest = async (inputMessages: ClientMessage[], tokenBudget: number): Promise<AnthropicResponse> => {
      const bodyPayload: Record<string, unknown> = {
      model: resolvedModel,
      max_tokens: tokenBudget,
      temperature: 0,
      system: systemPrompt,
      messages: toAnthropicMessages(inputMessages),
      };

      if (useMcp) {
        bodyPayload.mcp_servers = [
          {
            type: "url",
            name: HELIUS_MCP_SERVER_NAME,
            url: HELIUS_MCP_URL,
          },
        ];
        bodyPayload.tools = [
          {
            type: "mcp_toolset",
            mcp_server_name: HELIUS_MCP_SERVER_NAME,
          },
        ];
      }

      const response = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          ...(useMcp ? { "anthropic-beta": ANTHROPIC_BETA } : {}),
        },
        body: JSON.stringify(bodyPayload),
      });

      const responseBody = (await response.json()) as AnthropicResponse;
      if (!response.ok) {
        const errorMessage = responseBody.error?.message ?? "Anthropic request failed.";
        throw new Error(errorMessage);
      }

      return responseBody;
    };

    let responseBody = await sendAnthropicRequest(messages, maxTokens);
    let reply = extractAssistantText(responseBody);
    if (!reply) {
      return NextResponse.json(
        { error: "Claude returned no text response. Try rephrasing your request." },
        { status: 502 },
      );
    }

    let parsed = extractJsonObject(reply);
    if (!parsed || responseBody.stop_reason === "max_tokens") {
      const retryMessages: ClientMessage[] = [
        ...messages,
        {
          role: "user",
          text: "Return ONLY one complete valid JSON object following the required schema. No markdown, no commentary.",
        },
      ];
      responseBody = await sendAnthropicRequest(retryMessages, Math.max(maxTokens + 400, 900));
      reply = extractAssistantText(responseBody) || reply;
      parsed = extractJsonObject(reply);
    }

    const parsedReply = parsed ? toNonEmptyString(parsed.reply) : null;

    const proposedInput = parsed?.proposedNodes ?? parsed?.proposedNode ?? null;
    const { proposals, canAddNodes, availabilityError } = validateProposals(proposedInput);

    const responseReply =
      parsedReply ??
      (proposals.length > 0
        ? `Planned nodes:\n${proposals
            .map((proposal, index) => {
              const args = proposal.paramsByField
                ? JSON.stringify(proposal.paramsByField)
                : JSON.stringify(proposal.rawParams ?? []);
              return `${index + 1}. ${proposal.method} ${args}`;
            })
            .join("\n")}`
        : reply);

    return NextResponse.json({
      reply: responseReply,
      nodeProposals: proposals,
      canAddNodes,
      availabilityError,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
