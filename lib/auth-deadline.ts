import { AUTH_TIMEOUT_MS } from "./supabase/fetch";
// Refresh may retry internally; limit the whole operation, preserve cookies on
// temporary failure, and abort further network attempts after the deadline.
export async function authDeadline<T>(
  action: () => Promise<T>,
  controller: AbortController,
  milliseconds = AUTH_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new DOMException("Authentication timed out", "TimeoutError"));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
