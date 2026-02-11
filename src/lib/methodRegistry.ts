import generatedRegistry from "@/lib/generatedMethodRegistry.json";

export type SchemaMode = "known" | "unknown";

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

export function getMethodNames(): string[] {
  return methodRegistry.methods.map((entry) => entry.method).sort((a, b) => a.localeCompare(b));
}
