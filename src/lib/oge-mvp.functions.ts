import { createServerFn } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { loadMvpStateForUser } from "@/lib/oge-mvp-state.server";

export const loadMvpState = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    try {
      // The browser receives lesson content and personal progress, never keys,
      // explanations, or solution text.
      return await loadMvpStateForUser(context.userId, false);
    } catch (error) {
      console.error("Failed to load MVP state", error);
      throw new Error("Не удалось загрузить данные занятий.");
    }
  });
