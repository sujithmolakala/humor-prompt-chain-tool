import { requireSuperadmin } from "@/lib/auth";
import { rpc } from "@/lib/tool-data";
import { checkOrigin, jsonBody, idSchema } from "@/lib/security";
import { apiError, json } from "@/lib/http";
import { z } from "zod";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const access = await requireSuperadmin();
    const i = z
      .object({
        target: idSchema,
        step_target: idSchema.nullable(),
        expected_revision: z.number().int().nonnegative(),
      })
      .strict()
      .parse(await jsonBody(request));
    return json(await rpc(access, "pct_duplicate", i));
  } catch (e) {
    return apiError(e);
  }
}
