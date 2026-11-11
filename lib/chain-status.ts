import "server-only";
import type { AdminAccess } from "./auth";
import type { RuntimeState } from "./runtime-admin";
import { AppError } from "./security";
import { getState, rpc } from "./tool-data";

export function chainStatusAllocations(
  state: RuntimeState,
  id: string,
  enabled: boolean,
) {
  const target = state.chains.find((c) => c.id === id);
  if (!target) throw new AppError("Prompt chain not found.", 404);
  if (enabled && !target.steps.length)
    throw new AppError(
      "Add at least one workflow step before activating this chain.",
    );
  const active = state.chains.filter((c) =>
    c.id === id ? enabled : c.enabled,
  );
  if (active.length > 4)
    throw new AppError(
      "Only four prompt chains can be active. Deactivate another chain first.",
    );
  if (!active.length)
    throw new AppError(
      "The existing runtime requires at least one usable active chain. Activate another chain before deactivating this one.",
    );
  // Keep relative existing weights. A newly active chain receives an equal share;
  // the existing chains split the remainder proportionally. Use hundredths so
  // the atomic mix RPC always receives a total of exactly 100 percent.
  const existing = active.filter(
    (c) => c.id !== id || !enabled || target.enabled,
  );
  const total = existing.reduce((sum, c) => sum + Number(c.allocation), 0);
  const weights = active.map((c) => ({
    chain_id: c.id,
    weight:
      enabled && !target.enabled && c.id === id
        ? total > 0
          ? total / existing.length
          : 1
        : total > 0
          ? Number(c.allocation)
          : 1,
  }));
  const sum = weights.reduce((n, c) => n + c.weight, 0);
  const portions = weights.map((c) => ({
    chain_id: c.chain_id,
    exact: (c.weight / sum) * 10000,
  }));
  const units = portions.map((c) => Math.floor(c.exact));
  const remainder = 10000 - units.reduce((n, v) => n + v, 0);
  const order = portions
    .map((c, i) => ({ i, fraction: c.exact - units[i] }))
    .sort((a, b) => b.fraction - a.fraction || a.i - b.i);
  for (let i = 0; i < remainder; i++) units[order[i].i]++;
  return portions.map((c, i) => ({
    chain_id: c.chain_id,
    allocation: units[i] / 100,
  }));
}

export async function setChainActive(
  access: AdminAccess,
  id: string,
  enabled: boolean,
  revision: number,
): Promise<RuntimeState> {
  const state = await getState(access);
  if (Number(state.settings.revision) !== revision)
    throw new AppError(
      "This configuration changed in another session. Reload before saving.",
      409,
    );
  const allocations = chainStatusAllocations(state, id, enabled);
  if (state.chains.find((c) => c.id === id)!.enabled === enabled) return state;
  // hs_admin_save authorizes again, locks the settings row, rejects stale
  // revisions and validates every active snapshot before committing the mix.
  return rpc<RuntimeState>(access, "hs_admin_save", {
    operation: "mix",
    payload: { allocations },
    expected_revision: revision,
  });
}
