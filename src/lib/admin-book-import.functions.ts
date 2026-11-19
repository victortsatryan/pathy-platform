import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { auditIntakeSchema, importAuditResult } from "@/lib/extractor/audit-intake.server";

/** Legacy book UI is an adapter to the common source-bound job intake. */
export const importBookBatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: unknown) => auditIntakeSchema.parse(input))
  .handler(async ({ data, context }) => importAuditResult(context.supabase, context.userId, data));
