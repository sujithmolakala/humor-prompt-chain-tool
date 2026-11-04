import { notFound } from "next/navigation";
import { requireAdminPage } from "@/lib/auth";
import { getState } from "@/lib/tool-data";
import { Heading, Setup } from "@/components/Common";
import Studio from "@/components/Studio";
export default async function Editor({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const access = await requireAdminPage();
  let state;
  try {
    state = await getState(access);
  } catch {
    return <Setup message="The prompt runtime is unavailable." />;
  }
  const { id } = await params;
  const chain = state.chains.find((c) => c.id === id);
  if (!chain) notFound();
  return (
    <>
      <Heading
        eyebrow="CHAIN EDITOR"
        title={chain.name}
        description="Arrange the workflow in execution order. Every saved change is revision checked."
      />
      <Studio initial={state} chainId={id} />
    </>
  );
}
