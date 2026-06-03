// Cheap transport checks (no model turn, no tokens):
//   1. initialize + initialized + model/list
//   2. reconnect — after shutdown, getClient() spins up a fresh app-server.

import { getClient, shutdownClient } from "../src/codexAgent.js";
import { detectCodexVersion, versionDriftNote, VERIFIED_CODEX_VERSION } from "../src/codexVersion.js";

try {
  const client = await getClient();
  console.log("state:", client.readyState);
  const ver = await detectCodexVersion();
  console.log("codex version:", ver ?? "(unknown)", `(runner verified against ${VERIFIED_CODEX_VERSION})`);
  const drift = versionDriftNote(ver);
  if (drift) console.error(drift);
  const models = await client.listModels();
  console.log("models exposed:", models.length);
  const sample = models.slice(0, 6).map((m) =>
    typeof m === "string" ? m : m?.id ?? m?.slug ?? m?.name ?? JSON.stringify(m).slice(0, 48),
  );
  console.log("sample:", sample);

  // Reconnect proof.
  await shutdownClient();
  const client2 = await getClient();
  console.log("reconnected:", client2.readyState, "| new instance:", client2 !== client);
} catch (e) {
  console.error("handshake failed:", e?.message ?? e);
  process.exitCode = 1;
} finally {
  await shutdownClient();
}
