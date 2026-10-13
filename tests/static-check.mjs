/**
 * Check release invariants that do not require a configured worker model or network request.
 */

import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const [source, gateProbe, fakeRpcWorker] = await Promise.all([
	readFile(new URL("../extensions/task-dispatcher.ts", import.meta.url), "utf8"),
	readFile(new URL("./gate-probe.mjs", import.meta.url), "utf8"),
	readFile(new URL("./fake-rpc-worker.mjs", import.meta.url), "utf8"),
]);

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
	"delegate_mechanical",
	"delegate_assistant",
	"delegate_engineering",
	"delegate_designer",
	"delegate_control",
	"delegate_status",
	"codemode-only.ts",
	"createCodemodeExtension",
	'mode: "only"',
	"task_dispatcher_boundary",
	"without an enforced IPC boundary",
	"--no-extensions",
	"ctx.abort()",
	"set_auto_compaction",
	"get_session_stats",
	"renderResult",
	"truncateToVisualLines",
	"truncateToWidth",
	'keyHint("app.tools.expand", "to expand")',
	"stripTerminalSequences",
	"message_update",
	"tool_execution_update",
	"PRESENTATION_UPDATE_THROTTLE_MS",
	"context.lastComponent",
	"task_dispatcher_proxy_request",
	"task_dispatcher_proxy_cancel",
	"task_dispatcher_proxy_update",
	"task_dispatcher_proxy_result",
	"buildDelegatedToolManifests",
	"ctx.executeTool",
	"revalidateManifest",
	"openExecutorLease",
	"authorizeNestedToolCall",
	"PROXY_PAYLOAD_LIMIT_BYTES",
	"PROXY_MAX_IN_FLIGHT_REQUESTS",
	"PROXY_MAX_REQUESTS_PER_JOB",
	"REVOKED_EXECUTOR_ROOT_LIMIT",
	"revokedExecutorGuardSaturated",
	"randomBytes",
	"Type.Unsafe",
]) {
	if (!source.includes(required)) throw new Error(`Missing supervised-protocol marker: ${required}`);
}

if (packageJson.version !== "3.2.2") throw new Error(`Expected release version 3.2.2, found ${packageJson.version}`);
// Keep test-side RPC framing independent from readline's broader line-separator behavior.
for (const [name, reader] of [["fake RPC worker", fakeRpcWorker], ["gate probe", gateProbe]]) {
	if (reader.includes("node:readline")) throw new Error(`${name} still imports node:readline.`);
}
if (source.includes("builtin:codemode")) throw new Error("The dispatcher must not load codemode through a built-in extension selector.");
for (const forbidden of ["ISOLATED_WORKER_TOOLS", "MUTATING_TOOLS", "Isolated workers do not support these tools"]) {
	if (source.includes(forbidden)) throw new Error(`Legacy tool-name classification remains in source: ${forbidden}`);
}
if (!source.includes("ctx.tools")) throw new Error("Delegated tool grants must be built from manager-callable ctx.tools.");
if (!fakeRpcWorker.includes("security-cross-job") || !fakeRpcWorker.includes("security-paused") || !fakeRpcWorker.includes("proxy-rich") || !fakeRpcWorker.includes("transitive")) {
	throw new Error("The deterministic worker no longer covers proxy security and rich-result transport.");
}
for (const required of ['"task-dispatcher.ts"', "managerCalls", 'tools: ["read", "codemode"]', "parentToolCallId"]) {
	if (!gateProbe.includes(required)) throw new Error(`The live gate probe no longer exercises the release proxy/codemode path: ${required}`);
}
console.log(`Static supervised-protocol checks passed for ${packageJson.name}@${packageJson.version}.`);
