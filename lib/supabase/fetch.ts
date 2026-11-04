// Never allow framework data caching of identity/session responses. Bound only
// auth and identity calls; ordinary uploads/data RPCs retain their own budgets.
export const AUTH_TIMEOUT_MS = 8000;
export const authFetch: typeof fetch = (input, init) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  const incoming =
    init?.signal || (input instanceof Request ? input.signal : undefined);
  const bounded =
    url.pathname.startsWith("/auth/v1/") ||
    url.pathname === "/rest/v1/rpc/admin_identity";
  const signal = bounded
    ? AbortSignal.any([
        AbortSignal.timeout(AUTH_TIMEOUT_MS),
        ...(incoming ? [incoming] : []),
      ])
    : incoming;
  return fetch(input, { ...init, cache: "no-store", signal });
};
