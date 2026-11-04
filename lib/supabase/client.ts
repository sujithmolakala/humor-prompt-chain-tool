"use client";
import { createBrowserClient } from "@supabase/ssr";
import { publicConfig, cookieOptions } from "./config";
export function browserClient() {
  const { url, key } = publicConfig();
  return createBrowserClient(url, key, {
    cookieOptions,
    auth: { detectSessionInUrl: false },
  });
}
