/**
 * Check release invariants that do not require a configured worker model or network request.
 */

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const source = await readFile(new URL("../extensions/task-dispatcher.ts", import.meta.url), "utf8");
const gateProbe = await readFile(new URL("./gate-probe.mjs", import.meta.url), "utf8");

// Keep task budgets formula-owned and prevent accidental restoration of the v2 role limits.
for (const forbidden of ["checkpointGraceSeconds", "timeoutSeconds", "maxTurns"]) {
	if (source.includes(forbidden)) throw new Error(`Removed v2 task-budget field remains in source: ${forbidden}`);
}

// Keep runtime and live tests provider/model agnostic unless the caller explicitly supplies an override.
for (const forbidden of ["gpt-5.6-luna", "gpt-5.6-terra", "openai-codex/"]) {
	if (`${source}\n${gateProbe}`.includes(forbidden)) throw new Error(`Hardcoded model assumption remains: ${forbidden}`);
}
if (!source.includes("let model = ctx.model")) throw new Error("Role defaults no longer inherit the active model.");

// Require the supervised protocol and its externally enforced gate in every v3 candidate.
for (const required of [
	"delegate_control",
	"delegate_status",
	"task_dispatcher_boundary",
	"without an enforced IPC boundary",
	"--no-extensions",
	"ctx.abort()",
	"set_auto_compaction",
	"get_session_stats",
	"renderResult",
]) {
	if (!source.includes(required)) throw new Error(`Missing supervised-protocol marker: ${required}`);
}

if (!String(packageJson.version).startsWith("3.")) throw new Error(`Expected a v3 package version, found ${packageJson.version}`);
console.log(`Static supervised-protocol checks passed for ${packageJson.name}@${packageJson.version}.`);
