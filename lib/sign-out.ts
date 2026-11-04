import { cookieOptions } from "./supabase/config";
export const SIGN_OUT_TIMEOUT_MS = 1500;
export function isAdminAuthCookie(name: string) {
  return (
    name === cookieOptions.name ||
    name.startsWith(cookieOptions.name + ".") ||
    name.startsWith(cookieOptions.name + "-")
  );
}
