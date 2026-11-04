import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cookieOptions, publicConfig } from "./config";
import { authFetch } from "./fetch";
export async function serverClient() {
  const jar = await cookies();
  const { url, key } = publicConfig();
  return createServerClient(url, key, {
    cookieOptions,
    global: { fetch: authFetch },
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (entries) => {
        try {
          entries.forEach(({ name, value, options }) =>
            jar.set(name, value, options),
          );
        } catch {
          /* Server Components rely on proxy refresh. */
        }
      },
    },
  });
}
