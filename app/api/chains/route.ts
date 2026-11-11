import { requireSuperadmin } from "@/lib/auth";
import { getState, rpc } from "@/lib/tool-data";
import { checkOrigin, jsonBody } from "@/lib/security";
import { apiError, json } from "@/lib/http";
import { z } from "zod";
import { setChainActive } from "@/lib/chain-status";
import { verifyModelApproval } from "@/lib/verify-model-approval";
export async function GET() {
  try {
    return json(await getState(await requireSuperadmin()));
  } catch (e) {
    return apiError(e);
  }
}
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const access = await requireSuperadmin();
    const i = z
      .object({
        operation: z.enum([
          "set_chain_active",
          "create_chain",
          "edit_chain",
          "delete_chain",
          "create_step",
          "edit_step",
          "delete_step",
          "reorder",
          "approve_model",
          "default_model",
        ]),
        payload: z.record(z.string(), z.unknown()),
        revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(await jsonBody(request, 65536));
    if (i.operation === "set_chain_active") {
      const payload = z
        .object({ id: z.uuid(), enabled: z.boolean() })
        .strict()
        .parse(i.payload);
      return json(
        await setChainActive(access, payload.id, payload.enabled, i.revision),
      );
    }
    if (i.operation === "approve_model")
      await verifyModelApproval(access, i.payload, i.revision);
    return json(
      await rpc(access, "hs_admin_save", {
        operation: i.operation,
        payload: i.payload,
        expected_revision: i.revision,
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
