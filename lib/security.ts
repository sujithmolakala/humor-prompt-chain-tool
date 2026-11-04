import { z } from "zod";
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const idSchema = z.uuid();
export const mutationSchema = z
  .object({
    requestId: idSchema,
    caption: z.string().trim().min(1).max(280),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const deletionSchema = z
  .object({ requestId: idSchema, updatedAt: z.iso.datetime({ offset: true }) })
  .strict();
export const querySchema = z
  .object({
    q: z.string().trim().max(100).default(""),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    sort: z.string().max(30).optional(),
    vote: z.enum(["all", "positive", "negative"]).default("all"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    days: z.enum(["7", "30", "90", "0"]).default("30"),
  })
  .refine(
    (x) => !x.from || !x.to || x.from <= x.to,
    "End date must follow start date",
  );
export function parseQuery(params: URLSearchParams) {
  return querySchema.parse(Object.fromEntries(params));
}
export function safeNext(value: string | null): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value)
  )
    return "/";
  const url = new URL(value, "https://local.invalid");
  if (/^\/(auth|sign-in|access-denied)(\/|$)/.test(url.pathname)) return "/";
  for (const key of [
    "code",
    "error",
    "error_code",
    "error_description",
    "sb_flow_id",
  ])
    url.searchParams.delete(key);
  return url.pathname + url.search;
}
export const productionOrigin =
  "https://humor-prompt-chain-tool-ashy.vercel.app";
export function configuredAppOrigin() {
  const value = process.env.APP_ORIGIN;
  const invalid = () =>
    new AppError("Application origin is not configured correctly.", 503);
  if (!value) {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.VERCEL_ENV === "production"
    )
      throw invalid();
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
    url.hostname === "humor-prompt-chain-tool.vercel.app" ||
    (process.env.VERCEL_ENV === "production" && url.origin !== productionOrigin)
  )
    throw invalid();
  return url.origin;
}
export function requestOrigin(request: Request) {
  const configured = configuredAppOrigin();
  if (configured) return configured;
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Browser Origin must match the actual target Host, not Next's internal server hostname.
  // Forwarded-Host is deliberately not trusted. Production should set APP_ORIGIN.
  if (host) url.host = host;
  return url.origin;
}
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (
    !origin ||
    origin !== requestOrigin(request) ||
    request.headers.get("sec-fetch-site") === "cross-site"
  )
    throw new AppError(
      "This request could not be verified. Reload and try again.",
      403,
    );
}
export async function boundedBody(request: Request, max: number) {
  if (Number(request.headers.get("content-length")) > max)
    throw new AppError("Upload is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new AppError("Request body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel();
      throw new AppError("Upload is too large.", 413);
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
export async function jsonBody(request: Request, max = 4096) {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new AppError("Send JSON.");
  try {
    return JSON.parse(
      new TextDecoder().decode(await boundedBody(request, max)),
    ) as unknown;
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError("Invalid JSON.");
  }
}
export const privateHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
export function csvCell(value: unknown) {
  let s = String(value ?? "");
  if (/^[\s]*[=+\-@\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}

export function checkFormKeys(form: FormData, allowed: string[]) {
  const seen = new Set<string>();
  for (const key of form.keys()) {
    if (!allowed.includes(key) || seen.has(key))
      throw new AppError("Unexpected upload fields.");
    seen.add(key);
  }
}
