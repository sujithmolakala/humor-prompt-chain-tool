import { requireSuperadmin } from "@/lib/auth";
import { getHistory } from "@/lib/tool-data";
import { idSchema } from "@/lib/security";
import { apiError, json } from "@/lib/http";
import { z } from "zod";
export async function GET(request: Request) {
  try {
    const access = await requireSuperadmin();
    const q = new URL(request.url).searchParams;
    return json(
      await getHistory(access, {
        target: q.has("chain") ? idSchema.parse(q.get("chain")) : null,
        run_token: q.has("run") ? idSchema.parse(q.get("run")) : null,
        page_number: z.coerce
          .number()
          .int()
          .min(1)
          .max(100000)
          .parse(q.get("page") || 1),
      }),
    );
  } catch (e) {
    return apiError(e);
  }
}
