import { executionLogProbe } from "@/lib/execution-log-probe";
import { executionTrace } from "@/lib/execution-diagnostics";
import { requireSuperadmin } from "@/lib/auth";
import { checkOrigin, checkFormKeys, idSchema, AppError } from "@/lib/security";
import { uploadForm, validateImage } from "@/lib/images";
import { apiError, json } from "@/lib/http";
import { rpc } from "@/lib/tool-data";
import { type ExecutionSnapshot } from "@/lib/chain-execution";
import { executionStream } from "@/lib/execution-stream";
import { providerKey } from "@/lib/provider";
import { createHash } from "node:crypto";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A GET checks runtime logging only. It cannot reserve or dispatch generation.
export async function GET() {
  return executionLogProbe(requireSuperadmin);
}
export const maxDuration = 120;
export async function POST(request: Request) {
  const trace = executionTrace();
  trace.event("request_received", { method: "POST", route: "/api/execute" });
  try {
    checkOrigin(request);
    const access = await trace.measure("authorization", requireSuperadmin);
    const key = providerKey();
    await trace.measure("journal_capabilities", () =>
      rpc(access, "pct_recovery_ready"),
    );
    const form = await trace.measure("upload_form", () => uploadForm(request));
    checkFormKeys(form, ["requestId", "chainId", "image"]);
    const token = idSchema.parse(form.get("requestId")),
      chain = idSchema.parse(form.get("chainId"));
    trace.identify(token);
    const image = await trace.measure("image_validation", () =>
      validateImage(form.get("image")),
    );
    const path = `${access.identity.id}/${token}-${image.byteHash}.webp`;
    const storage = access.client.storage.from("prompt-chain-inputs");
    const { error } = await trace.measure("image_storage", () =>
      storage.upload(path, image.bytes, {
        contentType: image.mime,
        upsert: false,
      }),
    );
    if (error) {
      const { data } = await storage.download(path);
      if (
        !data ||
        createHash("sha256")
          .update(Buffer.from(await data.arrayBuffer()))
          .digest("hex") !== image.byteHash
      )
        throw new AppError(
          "Input image could not be saved. Verify the private storage migration and retry the same request.",
          503,
        );
    }
    const reservation = await trace.measure("reservation", () =>
      rpc<{
        dispatch: boolean;
        id: string;
        snapshot: ExecutionSnapshot;
      }>(access, "pct_start", {
        token,
        target: chain,
        saved_path: path,
        source_hash: image.byteHash,
      }),
    );
    trace.event("reservation", { dispatch: reservation.dispatch });
    if (!reservation.dispatch) return json({ existing: true, id: token }, 200);
    return executionStream(
      access,
      token,
      reservation.snapshot,
      image.bytes,
      key,
      [],
      { requestSignal: request.signal, trace },
    );
  } catch (error) {
    trace.event(
      "request_stopped",
      {
        requestOutcome: "no_new_provider_dispatch",
      },
      "error",
    );
    return apiError(error);
  }
}
