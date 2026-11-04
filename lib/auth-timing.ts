// Opt-in durations only: no tokens, codes, cookies, user IDs, or provider URLs.
export async function authTimed<T>(
  stage: string,
  action: () => PromiseLike<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await action();
  } finally {
    if (process.env.AUTH_TIMING === "1")
      console.info(
        JSON.stringify({
          event: "auth-timing",
          stage,
          ms: Math.round(performance.now() - start),
        }),
      );
  }
}
