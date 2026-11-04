import "server-only";
import { cookieOptions } from "./supabase/config";
import { safeNext } from "./security";
export const oauthContextName = `${cookieOptions.name}-oauth-context`;
export const oauthContextOptions = {
  path: cookieOptions.path,
  sameSite: cookieOptions.sameSite,
  secure: cookieOptions.secure,
  httpOnly: true,
  maxAge: 600,
};
export function encodeOAuthContext(next: string, flowId?: string | null) {
  return Buffer.from(JSON.stringify({ next: safeNext(next), flowId })).toString(
    "base64url",
  );
}
export function readOAuthContext(value?: string) {
  if (!value || value.length > 4096) return null;
  try {
    const context = JSON.parse(Buffer.from(value, "base64url").toString());
    if (
      typeof context.next !== "string" ||
      (context.flowId != null &&
        (typeof context.flowId !== "string" ||
          !/^[A-Za-z0-9_-]{8,64}$/.test(context.flowId)))
    )
      return null;
    return {
      next: safeNext(context.next),
      flowId: context.flowId as string | undefined,
    };
  } catch {
    return null;
  }
}
