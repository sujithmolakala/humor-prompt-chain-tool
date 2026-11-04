import { requireAdminPage } from "@/lib/auth";
import { getState } from "@/lib/tool-data";
import { Heading, Setup } from "@/components/Common";
import Execute from "@/components/Execute";
export default async function Execution({
  searchParams,
}: {
  searchParams: Promise<{ chain?: string }>;
}) {
  const access = await requireAdminPage();
  let state;
  try {
    state = await getState(access);
  } catch {
    return (
      <Setup message="Configure the prompt runtime and model approvals before executing a chain." />
    );
  }
  return (
    <>
      <Heading
        eyebrow="EXECUTION WORKSPACE"
        title="Watch the idea take shape."
        description="A real image. Sequential model calls. Every output saved to its chain."
      />
      <Execute state={state} selectedId={(await searchParams).chain} />
    </>
  );
}
