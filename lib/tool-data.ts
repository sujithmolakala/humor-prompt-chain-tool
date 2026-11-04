import "server-only";
import type { AdminAccess } from "./auth";
import type { RuntimeState } from "./runtime-admin";
import type { ExecutionSnapshot, StructuredOutput } from "./chain-execution";
import { AppError } from "./security";
export type Run = {
  id: string;
  chain_id: string;
  snapshot: ExecutionSnapshot;
  image_path: string;
  status: string;
  outputs: StructuredOutput[];
  current_step: number | null;
  error: string | null;
  started_at: string;
  finished_at: string | null;
};
export type History = {
  total: number;
  runs: Run[];
  stats: {
    total: number;
    completed: number;
    failed: number;
    uncertain: number;
  };
};
export async function rpc<T>(
  access: AdminAccess,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await access.client.rpc(name, args);
  if (error) {
    if (error.code === "42501")
      throw new AppError("Superadmin access required.", 403);
    if (error.code === "40001")
      throw new AppError(
        "This configuration changed in another session. Reload before saving.",
        409,
      );
    if (error.code === "23503")
      throw new AppError(
        "Historical executions or related records reference this item. Retain it to preserve history.",
        409,
      );
    if (error.code === "P0002") throw new AppError("Record not found.", 404);
    if (error.code === "P0001")
      throw new AppError(
        "Execution limit reached. Wait before starting another run.",
        429,
      );
    if (error.code === "22023")
      throw new AppError(
        "Invalid configuration. Check step order, template variables, approved models, and final caption role.",
        400,
      );
    throw new AppError(
      "Database setup is incomplete or unavailable. Review README migration prerequisites; no hosted migration is applied automatically.",
      503,
    );
  }
  return data as T;
}
export const getState = (a: AdminAccess) =>
  rpc<RuntimeState>(a, "hs_admin_state");
export async function getHistory(
  a: AdminAccess,
  args: Record<string, unknown> = {},
) {
  const history = await rpc<History>(a, "pct_history", args);
  return { ...history, asOf: Date.now() };
}
