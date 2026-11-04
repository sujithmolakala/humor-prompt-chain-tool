export function publicConfig() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error(
      "Supabase configuration is missing. Follow the setup guide.",
    );
  return { url, key };
}
export const cookieOptions = {
  name: "humor-prompt-chain-auth",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
