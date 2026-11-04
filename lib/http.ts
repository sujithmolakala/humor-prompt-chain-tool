import "server-only";
import { ZodError } from "zod";
import { AppError, privateHeaders } from "./security";
export function apiError(e: unknown) {
  const status =
    e instanceof AppError ? e.status : e instanceof ZodError ? 400 : 500;
  const error =
    e instanceof AppError
      ? e.message
      : e instanceof ZodError
        ? "Check the fields and try again."
        : "The request failed. Please try again.";
  return Response.json({ error }, { status, headers: privateHeaders });
}
export function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: privateHeaders });
}
export function databaseError(code?: string): never {
  if (code === "42501") throw new AppError("Your access has changed.", 403);
  if (code === "40001")
    throw new AppError(
      "This media changed in another window. Reload before saving.",
      409,
    );
  if (code === "P0002") throw new AppError("Media not found.", 404);
  if (code === "22023")
    throw new AppError("Invalid media or request token. Reload and try again.");
  throw new AppError(
    "The change could not be saved. Retry the same request safely.",
    503,
  );
}
