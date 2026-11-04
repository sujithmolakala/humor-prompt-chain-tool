// Explicit, opt-in provider check. No DB writes, runtime activation, or user images.
import { pathToFileURL } from "node:url";
import sharp from "sharp";
class ProbeError extends Error {}
/**
 * @param {{key:string,model:string,maxTokens?:number,temperature?:number,fetcher?:typeof fetch}} options
 */
export async function verifyRuntimeModel({
  key,
  model,
  maxTokens = 2048,
  temperature = 1,
  fetcher = fetch,
}) {
  if (
    !key ||
    !/^gemini-[a-z0-9.-]+$/.test(model) ||
    !Number.isInteger(maxTokens) ||
    maxTokens < 128 ||
    maxTokens > 4096 ||
    !Number.isFinite(temperature) ||
    temperature < 0 ||
    temperature > 2
  )
    throw new ProbeError("Invalid model probe configuration.");
  const base = `https://generativelanguage.googleapis.com/v1beta/models/${model}`;
  const headers = { "Content-Type": "application/json", "x-goog-api-key": key };
  const metadata = await fetcher(base, {
    headers,
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!metadata.ok)
    throw new ProbeError(
      `Model metadata rejected (HTTP ${metadata.status}). Check model access/key configuration without logging credentials.`,
    );
  const info = await metadata.json();
  if (
    info.name !== `models/${model}` ||
    !Array.isArray(info.supportedGenerationMethods) ||
    !info.supportedGenerationMethods.includes("generateContent") ||
    !Number.isInteger(info.outputTokenLimit) ||
    info.outputTokenLimit < maxTokens ||
    (typeof info.maxTemperature === "number" &&
      temperature > info.maxTemperature)
  )
    throw new ProbeError(
      "Provider metadata does not support the configured generation method/token/temperature settings.",
    );
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#b4a6f6" },
  })
    .png()
    .toBuffer();
  const response = await fetcher(base + ":generateContent", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(30000),
    cache: "no-store",
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              text: 'This is a synthetic color tile, not user data. Return only JSON {"ok":true} to confirm acceptance of this image and JSON generation configuration.',
            },
            {
              inlineData: {
                mimeType: "image/png",
                data: image.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature,
        maxOutputTokens: Math.min(maxTokens, 512),
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: { ok: { type: "BOOLEAN" } },
          required: ["ok"],
        },
      },
    }),
  });
  if (!response.ok)
    throw new ProbeError(
      `Image/JSON compatibility probe rejected (HTTP ${response.status}). Do not approve this model until resolved.`,
    );
  const payload = await response.json();
  const candidate = payload.candidates?.[0];
  if (payload.promptFeedback?.blockReason || candidate?.finishReason !== "STOP")
    throw new ProbeError("Provider did not complete the image/JSON probe.");
  let output;
  try {
    output = JSON.parse(
      candidate.content?.parts
        ?.filter((part) => !part.thought)
        .map((part) => part.text || "")
        .join("") || "",
    );
  } catch {
    throw new ProbeError("Provider did not return valid probe JSON.");
  }
  if (output?.ok !== true)
    throw new ProbeError(
      "Image/JSON probe did not satisfy the expected contract.",
    );
  return {
    model,
    metadataChecked: true,
    imageJsonProbePassed: true,
    maxTokens,
    temperature,
    checkedAt: new Date().toISOString(),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  if (args.includes("--help"))
    console.log(
      "Usage: node --env-file-if-exists=.env.local scripts/verify-runtime-model.mjs --allow-provider-call --model gemini-3.1-flash-lite --max-tokens 2048 --temperature 1\nThis performs one billable-capable Gemini generation call with a synthetic image. No database or application state is modified.",
    );
  else if (!args.includes("--allow-provider-call")) {
    console.error(
      "Refusing live provider call without --allow-provider-call. Review cost and use the real catalog model configuration first.",
    );
    process.exitCode = 2;
  } else {
    const arg = (name) => args[args.indexOf(name) + 1];
    verifyRuntimeModel({
      key: process.env.GEMINI_API_KEY || "",
      model: args.includes("--model")
        ? arg("--model")
        : process.env.GEMINI_MODEL || "",
      maxTokens: args.includes("--max-tokens")
        ? Number(arg("--max-tokens"))
        : 2048,
      temperature: args.includes("--temperature")
        ? Number(arg("--temperature"))
        : 1,
    })
      .then((result) => console.log(JSON.stringify(result)))
      .catch((error) => {
        console.error(
          error instanceof ProbeError
            ? error.message
            : "Model probe could not complete (network, timeout, or invalid provider response). No raw error payload is logged.",
        );
        process.exitCode = 1;
      });
  }
}
