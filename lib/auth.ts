import "server-only";
import { redirect } from "next/navigation";
import { serverClient } from "./supabase/server";
import { verifySuperadmin } from "./auth-core";
import { AppError } from "./security";
import { cache } from "react";
// React cache lasts only for this server render. Every HTTP request and every
// database RPC still checks live authorization; Route Handlers are not memoized.
export const requireSuperadmin = cache(async () => {
  let client;
  try {
    client = await serverClient();
  } catch {
    throw new AppError("Supabase is not configured. See the setup guide.", 503);
  }
  const identity = await verifySuperadmin(client);
  return { client, identity };
});
export type AdminAccess = Awaited<ReturnType<typeof requireSuperadmin>>;
export async function requireAdminPage() {
  try {
    return await requireSuperadmin();
  } catch (e) {
    if (e instanceof AppError && e.status === 401) redirect("/sign-in");
    if (e instanceof AppError && e.status === 403) redirect("/access-denied");
    redirect("/auth/error?temporary=1");
  }
}
