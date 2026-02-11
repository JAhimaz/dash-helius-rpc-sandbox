import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
  {
    variants: {
      variant: {
        default: "border-primary/30 bg-primary/20 text-primary",
        secondary: "border-border bg-foreground/10 text-foreground",
        success: "border-success/30 bg-success/15 text-success",
        warning: "border-warning/35 bg-warning/15 text-warning",
        destructive: "border-error/35 bg-error/15 text-error",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
