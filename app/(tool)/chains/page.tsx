import { requireAdminPage } from "@/lib/auth";
import { getState } from "@/lib/tool-data";
import { Heading, Setup } from "@/components/Common";
import Studio from "@/components/Studio";
export default async function Chains() {
  const access = await requireAdminPage();
  let state;
  try {
    state = await getState(access);
  } catch {
    return (
      <Setup message="Prompt chain management requires the existing admin catalog and prompt runtime migrations." />
    );
  }
  return (
    <>
      <Heading
        eyebrow="PROMPT CHAINS"
        title="Design the path to a better punchline."
        description="Reusable prompts, deliberate ordering, and the right model at every step."
      />
      <Studio initial={state} />
    </>
  );
}
