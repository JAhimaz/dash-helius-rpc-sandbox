import { z } from "zod";

export const paramValueSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("literal"),
    value: z.unknown(),
  }),
  z.object({
    type: z.literal("ref"),
    nodeId: z.string().min(1, "Reference node is required"),
    path: z.string().min(1, "Reference path is required"),
  }),
]);

export const paramBindingSchema = z.object({
  name: z.string().min(1),
  value: paramValueSchema,
}).strict();

export const nodeRepeatSchema = z
  .object({
    enabled: z.boolean(),
    count: z.number().int().min(1).max(1000),
    interval: z.number().int().min(0).max(86_400_000),
    unit: z.enum(["milliseconds", "seconds", "minutes"]),
    loopCount: z.number().int().min(0).max(100_000).default(1),
  })
  .strict();

export const nodePositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
  })
  .strict();

export const workflowNodeExportSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  method: z.string().min(1),
  schemaMode: z.enum(["known", "unknown"]),
  params: z.array(paramBindingSchema),
  rawParamsJson: z.string(),
  repeat: nodeRepeatSchema.optional(),
  position: nodePositionSchema.optional(),
  output: z.unknown().optional(),
}).strict();

export const workflowExportSchema = z.object({
  version: z.literal(1),
  nodes: z.array(workflowNodeExportSchema),
  order: z.array(z.string().min(1)),
  selectedNodeId: z.string().optional(),
  ui: z
    .object({
      includeOutputs: z.boolean().optional(),
    })
    .optional(),
}).strict();

export type ParamValue = z.infer<typeof paramValueSchema>;
export type ParamBinding = z.infer<typeof paramBindingSchema>;
export type NodeRepeat = z.infer<typeof nodeRepeatSchema>;
export type NodePosition = z.infer<typeof nodePositionSchema>;
export type WorkflowNodeExport = z.infer<typeof workflowNodeExportSchema>;
export type WorkflowExport = z.infer<typeof workflowExportSchema>;

export function parseWorkflowImport(payload: unknown) {
  return workflowExportSchema.safeParse(payload);
}

export function formatZodError(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "root";
    return `${path}: ${issue.message}`;
  });
}
