import { test } from "node:test";
import assert from "node:assert/strict";
import { fragmentOAuthOutcome, oauthMessage } from "../lib/oauth-errors";

test("fragment failures and error messages never render provider-controlled text or URLs", () => {
  assert.equal(
    fragmentOAuthOutcome(
      "#error=access_denied&error_description=https://public.invalid",
    ),
    "cancelled",
  );
  assert.equal(fragmentOAuthOutcome("#error=server_error"), "provider");
  assert.equal(fragmentOAuthOutcome("#access_token=private"), undefined);
  for (const input of [
    "https://public.invalid",
    "<script>",
    "__proto__",
    undefined,
  ])
    assert.equal(oauthMessage(input), undefined);
  for (const key of [
    "cancelled",
    "provider",
    "expired",
    "session",
    "unavailable",
  ])
    assert.match(oauthMessage(key)!, /sign.in/i);
});
