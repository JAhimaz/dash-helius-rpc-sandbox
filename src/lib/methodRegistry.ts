import generatedRegistry from "@/lib/generatedMethodRegistry.json";

export type SchemaMode = "known" | "unknown";
export type MethodCategoryId =
  | "solana-rpc-apis"
  | "digital-asset-standard-das"
  | "wallet-api"
  | "zk-compression"
  | "custom";
export type MethodTransport = "jsonrpc" | "http" | "custom";
export type HttpMethod = "GET" | "POST";
export type JsonRpcParamsStyle = "array" | "object";

export interface StructuredField {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface TableSchema {
  kind: "table";
  fields: StructuredField[];
}

export interface JsonExampleSchema {
  kind: "json_example";
  value: unknown;
}

export type StructuredSchema = TableSchema | JsonExampleSchema;

export interface MethodHttpConfig {
  method: HttpMethod;
  path: string;
  mainnetBaseUrl?: string;
  devnetBaseUrl?: string;
}

export interface MethodErrorOutput {
  httpStatus: number;
  code?: number;
  message?: string;
  description?: string;
  example?: unknown;
}

export interface MethodRegistryEntry {
  method: string;
  docsUrl: string;
  category?: MethodCategoryId;
  transport?: MethodTransport;
  jsonrpcParamsStyle?: JsonRpcParamsStyle;
  http?: MethodHttpConfig;
  schema: SchemaMode;
  params?: StructuredSchema;
  response?: StructuredSchema;
  errors?: MethodErrorOutput[];
}

export interface MethodRegistryFile {
  sourceUrl: string;
  generatedAt: string;
  methods: MethodRegistryEntry[];
}

export const methodRegistry: MethodRegistryFile = generatedRegistry as MethodRegistryFile;

export function getMethodEntry(method: string): MethodRegistryEntry | undefined {
  return methodRegistry.methods.find((entry) => entry.method === method);
}

export function getMethodEntries(): MethodRegistryEntry[] {
  return [...methodRegistry.methods].sort((a, b) => a.method.localeCompare(b.method));
}

export function getMethodNames(): string[] {
  return getMethodEntries().map((entry) => entry.method);
}
