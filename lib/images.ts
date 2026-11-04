import "server-only";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { AppError, boundedBody } from "./security";
export async function uploadForm(request: Request) {
  const type = request.headers.get("content-type");
  if (!type?.startsWith("multipart/form-data"))
    throw new AppError("Use an image upload form.");
  const bytes = await boundedBody(request, 3 * 1024 * 1024 + 65536);
  try {
    return await new Response(bytes, {
      headers: { "Content-Type": type },
    }).formData();
  } catch {
    throw new AppError("Invalid upload form.");
  }
}
export async function validateImage(value: FormDataEntryValue | null) {
  if (!(value instanceof File) || !value.size || value.size > 3 * 1024 * 1024)
    throw new AppError("Choose a JPEG, PNG, or WebP image up to 3 MB.");
  const source = Buffer.from(await value.arrayBuffer());
  try {
    const image = sharp(source, {
      limitInputPixels: 20000000,
      animated: false,
    });
    const meta = await image.metadata();
    if (
      !["jpeg", "png", "webp"].includes(meta.format || "") ||
      (meta.pages || 1) !== 1
    )
      throw new Error();
    // Normalize stored bytes, strip metadata and bound output dimensions.
    const bytes = await image
      .rotate()
      .resize({
        width: 2400,
        height: 2400,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 88 })
      .toBuffer();
    if (bytes.length > 3 * 1024 * 1024) throw new Error();
    // Match the rating app's oriented source-pixel identity before lossy storage normalization.
    const { data, info } = await sharp(source, {
      limitInputPixels: 20000000,
      animated: false,
    })
      .rotate()
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const hash = createHash("sha256")
      .update(`${info.width}:${info.height}:`)
      .update(data)
      .digest("hex");
    return {
      bytes,
      hash,
      byteHash: createHash("sha256").update(bytes).digest("hex"),
      mime: "image/webp",
    };
  } catch {
    throw new AppError(
      "Choose a valid, non-animated image up to 20 megapixels.",
    );
  }
}
