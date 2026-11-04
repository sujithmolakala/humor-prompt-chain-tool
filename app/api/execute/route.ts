import { requireSuperadmin } from "@/lib/auth";
import {
  checkOrigin,
  checkFormKeys,
  idSchema,
  privateHeaders,
  AppError,
} from "@/lib/security";
import { uploadForm, validateImage } from "@/lib/images";
import { apiError, json } from "@/lib/http";
import { rpc } from "@/lib/tool-data";
import { executeChain, type ExecutionSnapshot } from "@/lib/chain-execution";
import { generate, providerKey } from "@/lib/provider";
import { createHash } from "node:crypto";
export const runtime = "nodejs";
export const maxDuration = 120;
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const access = await requireSuperadmin();
    const key = providerKey();
    const form = await uploadForm(request);
    checkFormKeys(form, ["requestId", "chainId", "image"]);
    const token = idSchema.parse(form.get("requestId")),
      chain = idSchema.parse(form.get("chainId"));
    const image = await validateImage(form.get("image"));
    const path = `${access.identity.id}/${token}-${image.byteHash}.webp`;
    const storage = access.client.storage.from("prompt-chain-inputs");
    const { error } = await storage.upload(path, image.bytes, {
      contentType: image.mime,
      upsert: false,
    });
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
    const reservation = await rpc<{
      dispatch: boolean;
      id: string;
      snapshot: ExecutionSnapshot;
    }>(access, "pct_start", {
      token,
      target: chain,
      saved_path: path,
      source_hash: image.byteHash,
    });
    if (!reservation.dispatch) return json({ existing: true, id: token }, 200);
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (event: unknown) => {
          try {
            controller.enqueue(
              new TextEncoder().encode(JSON.stringify(event) + "\n"),
            );
          } catch {
            /* client disconnected; retain journal */
          }
        };
        const deadline = AbortSignal.timeout(95000);
        try {
          emit({ type: "started", id: token, snapshot: reservation.snapshot });
          const result = await executeChain(
            reservation.snapshot,
            [],
            async (step, index, prompt, _final, validate) => {
              if (deadline.aborted) throw new Error("deadline");
              await rpc(access, "pct_progress", { token, step_index: index });
              emit({ type: "running", index });
              const output = validate(
                await generate(step, prompt, image.bytes, key, deadline),
              );
              await rpc(access, "pct_progress", {
                token,
                step_index: index,
                result: output,
              });
              emit({ type: "completed", index, output });
              return output;
            },
            5,
          );
          await rpc(access, "pct_progress", {
            token,
            step_index: 0,
            outcome: "completed",
          });
          emit({ type: "finished", id: token, result });
        } catch (error) {
          // No automatic retry of a potentially billed call. Failed journal writes leave a visible running record.
          const uncertain = !(error instanceof AppError);
          try {
            await rpc(access, "pct_progress", {
              token,
              step_index: 0,
              outcome: uncertain ? "uncertain" : "failed",
            });
          } catch {
            /* history remains authoritative; never claim completion */
          }
          emit({
            type: "error",
            id: token,
            error:
              error instanceof AppError
                ? error.message
                : "Execution interrupted; provider outcome may be unknown. Inspect history before starting a new billable run.",
          });
        } finally {
          try {
            controller.close();
          } catch {
            /* disconnected */
          }
        }
      },
    });
    return new Response(stream, {
      headers: {
        ...privateHeaders,
        "Content-Type": "application/x-ndjson",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return apiError(error);
  }
}
