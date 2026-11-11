import { executionTrace } from "@/lib/execution-diagnostics";
import { requireSuperadmin } from "@/lib/auth";
import { AppError, checkOrigin, idSchema } from "@/lib/security";
import { getHistory, rpc, type Run } from "@/lib/tool-data";
import { validateSavedPrefix } from "@/lib/execution-runner";
import { executionStream } from "@/lib/execution-stream";
import { providerKey } from "@/lib/provider";
import { apiError, json } from "@/lib/http";
import { createHash } from "node:crypto";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const trace = executionTrace();
  trace.event("request_received", {
    method: "POST",
    route: "/api/execute/[id]/resume",
  });
  try {
    checkOrigin(request);
    const access = await trace.measure("authorization", requireSuperadmin);
    const token = idSchema.parse((await params).id);
    trace.identify(token);
    // Verify the immutable input before taking the resume reservation.
    const run = (
      await trace.measure("checkpoint_load", () =>
        getHistory(access, { run_token: token }),
      )
    ).runs[0];
    if (!run || run.actor !== access.identity.id)
      throw new AppError("Execution not found.", 404);
    try {
      validateSavedPrefix(run.snapshot, run.outputs);
    } catch {
      throw new AppError(
        "The saved execution contract is invalid. No model request was made; inspect its snapshot and saved outputs.",
        409,
      );
    }
    if (run.outputs.length === run.snapshot.steps.length) {
      const saved = await trace.measure("resume_reservation", () =>
        rpc<{ dispatch: boolean; run: Run }>(access, "pct_resume", { token }),
      );
      return json({ id: token, ...saved });
    }
    const key = providerKey();
    const { data, error } = await access.client.storage
      .from("prompt-chain-inputs")
      .download(run.image_path);
    if (error || !data)
      throw new AppError(
        "Saved input image is unavailable; no model call was made.",
        503,
      );
    const image = Buffer.from(await data.arrayBuffer());
    if (createHash("sha256").update(image).digest("hex") !== run.image_hash)
      throw new AppError(
        "Saved input integrity check failed; no model call was made.",
        409,
      );
    const saved = await trace.measure("resume_reservation", () =>
      rpc<{ dispatch: boolean; run: Run }>(access, "pct_resume", { token }),
    );
    trace.event("resume_reservation", {
      dispatch: saved.dispatch,
      savedOutputs: saved.run.outputs.length,
      currentStep: saved.run.current_step,
    });
    if (!saved.dispatch) return json({ id: token, ...saved });
    return executionStream(
      access,
      token,
      saved.run.snapshot,
      image,
      key,
      saved.run.outputs,
      { requestSignal: request.signal, trace },
    );
  } catch (error) {
    return apiError(error);
  }
}
