import "server-only";
import type { AdminAccess } from "./auth";
import { providerKey } from "./provider";
import { AppError, idSchema } from "./security";
import { verifyRuntimeModel } from "../scripts/verify-runtime-model.mjs";
export async function verifyModelApproval(
  access: AdminAccess,
  payload: Record<string, unknown>,
  revision: number,
) {
  const id = idSchema.parse(payload.id);
  const { data, error } = await access.client.rpc("hs_admin_state", {});
  if (error || !data)
    throw new AppError(
      "Model verification requires the reviewed prompt runtime setup.",
      503,
    );
  if (data.settings?.revision !== revision)
    throw new AppError(
      "Configuration changed; reload before verifying a model.",
      409,
    );
  const model = data.models?.find((m: { id: string }) => m.id === id);
  if (!model || !model.enabled || !model.provider_enabled)
    throw new AppError(
      "Select an enabled model and provider from the actual catalog.",
      400,
    );
  try {
    await verifyRuntimeModel({
      key: providerKey(),
      model: model.identifier,
      maxTokens: Number(model.max_tokens),
      temperature: Number(model.temperature),
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      "Gemini image/JSON compatibility verification failed. Review model access, generation settings, provider quota, and server credentials. No approval was saved.",
      503,
    );
  }
}
