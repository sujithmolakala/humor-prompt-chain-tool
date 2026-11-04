import { requireSuperadmin } from "@/lib/auth";
import { getHistory } from "@/lib/tool-data";
import { idSchema, privateHeaders, AppError } from "@/lib/security";
import { apiError } from "@/lib/http";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const access = await requireSuperadmin();
    const h = await getHistory(access, {
      run_token: idSchema.parse((await params).id),
    });
    const run = h.runs[0];
    if (!run) throw new AppError("Execution not found.", 404);
    const { data, error } = await access.client.storage
      .from("prompt-chain-inputs")
      .download(run.image_path);
    if (error || !data) throw new AppError("Image unavailable.", 404);
    return new Response(data, {
      headers: { ...privateHeaders, "Content-Type": "image/webp" },
    });
  } catch (e) {
    return apiError(e);
  }
}
