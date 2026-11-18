export type MaterialReadAccess = {
  viewerId: string;
  createdBy: string | null;
  status: string;
  isPublic: boolean;
  isAdmin: boolean;
};

export function canReadLessonDetails(input: {
  viewerId: string;
  ownerId: string;
  hasActiveTeacherLink: boolean;
}): boolean {
  return input.viewerId === input.ownerId || input.hasActiveTeacherLink;
}

export function canReadMaterial(input: MaterialReadAccess): boolean {
  return (
    (input.status === "published" && input.isPublic) ||
    input.createdBy === input.viewerId ||
    input.isAdmin
  );
}

export function canSearchTaskBank(isAdmin: boolean): boolean {
  return isAdmin;
}

export async function readIsAdmin(
  supabase: Pick<SupabaseClient<Database>, "rpc">,
  userId: string,
): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_role", {
    _user_id: userId,
    _role: "admin",
  });
  if (error) throw new Error(error.message);
  return data === true;
}
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/integrations/supabase/types";

