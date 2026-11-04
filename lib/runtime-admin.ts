import "server-only";
import type { AdminAccess } from "./auth";
import { AppError } from "./security";
export type RuntimeModel = {
  id: string;
  name: string;
  identifier: string;
  enabled: boolean;
  provider: string;
  provider_enabled: boolean;
  approved: boolean;
};
export type RuntimeStep = {
  id: string;
  chain_id: string;
  position: number;
  prompt_template: string;
  model_id: string | null;
  execution_role: string;
};
export type RuntimeChain = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  allocation: number;
  updated_at: string;
  steps: RuntimeStep[];
};
export type RuntimeState = {
  settings: { revision: number; default_model: string; enforce_mix: boolean };
  chains: RuntimeChain[];
  models: RuntimeModel[];
};
export async function optionalRuntime<T>(
  access: AdminAccess,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T | null> {
  const { data, error } = await access.client.rpc(name, args);
  if (error) {
    if (error.code === "42501")
      throw new AppError("Superadmin access required.", 403);
    if (["PGRST202", "42883", "42P01"].includes(error.code)) return null;
    return null;
  }
  return data as T;
}
