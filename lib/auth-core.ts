import { AppError } from "./security";
import type { Identity } from "./types";
import { sessionError, identityError } from "./auth-errors";
import { authTimed } from "./auth-timing";
export type AuthSource = {
  auth: {
    getUser(): Promise<{
      data: { user: { id: string } | null };
      error: unknown;
    }>;
  };
  rpc(name: string): PromiseLike<{ data: unknown; error: unknown }>;
};
// No persistent authorization cache: each request verifies the live user/role.
export async function verifySuperadmin(client: AuthSource): Promise<Identity> {
  let userId: string;
  try {
    const { data, error } = await authTimed("get-user", () =>
      client.auth.getUser(),
    );
    if (error) throw sessionError(error);
    if (!data.user) throw new AppError("Please sign in to continue.", 401);
    userId = data.user.id;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw sessionError(e);
  }
  try {
    const { data, error } = await authTimed("admin-identity", () =>
      client.rpc("admin_identity"),
    );
    if (error) throw identityError(error);
    if (
      !data ||
      typeof data !== "object" ||
      !("is_superadmin" in data) ||
      data.is_superadmin !== true ||
      !("id" in data) ||
      data.id !== userId
    )
      throw new AppError("Superadmin access is required.", 403);
    return data as Identity;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw identityError(e);
  }
}
