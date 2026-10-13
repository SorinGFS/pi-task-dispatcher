/** Exercise worker lifecycle, manager-proxied capabilities, and cleanup against a deterministic fake child. */

import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

// Resolve jiti from the installed Pi runtime so this package does not duplicate Pi's TypeScript loader.
const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(homedir(), ".pi", "agent", "install");
const piVersion = (await readFile(path.join(installRoot, "current-version"), "utf8")).trim();
const piRoot = path.join(installRoot, "releases", piVersion, "node_modules", "@earendil-works", "pi-coding-agent");
const requireFromPi = createRequire(path.join(piRoot, "package.json"));
const { createJiti } = requireFromPi("jiti");

const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-task-dispatcher-fake-rpc-"));
const configPath = path.join(temporaryDirectory, "task-dispatcher.json");
const promptMarker = path.join(temporaryDirectory, "prompts.txt");
const observationPath = path.join(temporaryDirectory, "observations.jsonl");
const inheritedWorkerRole = process.env.PI_TASK_DISPATCHER_WORKER;

function usage(input, output) {
	return {
		input,
		output,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input + output,
		cost: { input: input / 1000, output: output / 1000, cacheRead: 0, cacheWrite: 0, total: (input + output) / 1000 },
	};
}

function tool(name, label, description, annotations, executionMode = "parallel") {
	return {
		name,
		label,
		description,
		parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, action: { type: "string" }, value: { type: "string" } } },
		outputSchema: { type: "object", additionalProperties: true },
		executionMode,
		annotations,
	};
}

function terminal(status) {
	return new Set(["completed", "failed", "cancelled", "checkpointed", "taken_over", "hard_stopped"]).has(status);
}

async function observations() {
	const text = await readFile(observationPath, "utf8").catch(() => "");
	return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function clearObservations() {
	await writeFile(observationPath, "", "utf8");
}

async function waitForObservation(predicate, label) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const match = (await observations()).find(predicate);
		if (match) return match;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

async function waitFor(predicate, label) {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`Timed out waiting for ${label}.`);
}

// The test loads the parent extension even when invoked from a delegated review worker.
delete process.env.PI_TASK_DISPATCHER_WORKER;
process.env.PI_TASK_DISPATCHER_TEST_MODE = "1";
process.env.PI_TASK_DISPATCHER_CONFIG_PATH = configPath;
process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE = path.join(projectRoot, "tests", "fake-rpc-worker.mjs");
process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER = promptMarker;
process.env.PI_TASK_DISPATCHER_FAKE_OBSERVATION_MARKER = observationPath;

try {
	await writeFile(configPath, "{}\n", "utf8");
	const jiti = createJiti(import.meta.url, {
		interopDefault: true,
		alias: {
			"@earendil-works/pi-coding-agent": path.join(piRoot, "dist", "index.js"),
			"@earendil-works/pi-tui": requireFromPi.resolve("@earendil-works/pi-tui"),
			typebox: requireFromPi.resolve("typebox"),
		},
	});
	const loaded = await jiti.import(path.join(projectRoot, "extensions", "task-dispatcher.ts"));
	const register = loaded.default ?? loaded;
	const registeredTools = new Map();
	const handlers = new Map();
	const managerTools = [
		tool("read", "Read", "Manager-controlled read override", { readOnlyHint: true }, "parallel"),
		tool("bash", "Bash", "Manager-controlled command", { destructiveHint: true }, "sequential"),
		tool("edit", "Edit", "Manager-controlled edit", { destructiveHint: true }, "sequential"),
		tool("write", "Write", "Manager-controlled write", { destructiveHint: true }, "sequential"),
		tool("codemode", "Codemode", "Child-local codemode capability", { readOnlyHint: false }, "sequential"),
		tool("extension_tool", "Extension tool", "An extension-defined callable tool", { destructiveHint: true }, "parallel"),
		tool("rich_tool", "Rich tool", "A proxy serialization exercise", { destructiveHint: true }, "parallel"),
	];
	const managerMetadata = managerTools.map((entry) => ({
		name: entry.name,
		description: entry.description,
		parameters: entry.parameters,
		namespace: entry.name === "extension_tool" ? { name: "extension", description: "Manager extension namespace", instructions: "Use exact manager arguments.", aliases: ["extension-alias", "manager-extension"] } : undefined,
		annotations: entry.annotations,
		promptGuidelines: [`${entry.name} is controlled by the manager.`],
		sourceInfo: { path: `<fake:${entry.name}>`, source: "fake", scope: "temporary", origin: "top-level", baseDir: undefined },
	}));
	managerMetadata.push({ name: "registered_only", description: "Registered but excluded from this invocation", annotations: { readOnlyHint: true }, promptGuidelines: [], sourceInfo: { path: "<fake:registered-only>", source: "fake", scope: "temporary", origin: "top-level" } });
	const pi = {
		registerTool(entry) { registeredTools.set(entry.name, entry); },
		getActiveTools() { return managerTools.map((entry) => entry.name); },
		getAllTools() { return managerMetadata; },
		on(event, handler) { handlers.set(event, handler); },
	};
	register(pi);

	const activeModel = { provider: "fake-provider", id: "active-model", contextWindow: 272_000, maxTokens: 128_000 };
	const statusUpdates = [];
	const parentExecutions = [];
	const transitiveDecisions = [];
	let activeParentExecutions = 0;
	let maximumConcurrentParentExecutions = 0;
	const context = {
		cwd: projectRoot,
		hasUI: true,
		model: activeModel,
		thinkingLevel: "medium",
		get tools() { return managerTools.filter((tool) => tool.name !== "codemode"); },
		ui: {
			theme: { fg(_color, text) { return text; } },
			setWidget() {},
			setStatus(key, text) { statusUpdates.push({ key, text }); },
		},
		modelRegistry: {
			find(provider, id) { return { provider, id, contextWindow: 272_000, maxTokens: 128_000 }; },
			hasConfiguredAuth() { return true; },
		},
		async executeTool(name, args, options) {
			const call = { name, args, options, aborted: false, usage: undefined };
			parentExecutions.push(call);
			activeParentExecutions++;
			maximumConcurrentParentExecutions = Math.max(maximumConcurrentParentExecutions, activeParentExecutions);
			try {
				if (process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO === "transitive" && name === "extension_tool") {
					const authorize = handlers.get("tool_call");
					transitiveDecisions.push(
						authorize?.({ type: "tool_call", toolCallId: "start-transitive/1", parentToolCallId: "start-transitive", toolName: "extension_tool", input: args }, context),
						authorize?.({ type: "tool_call", toolCallId: "start-transitive/1/1", parentToolCallId: "start-transitive/1", toolName: "read", input: { path: "allowed.txt" } }, context),
						authorize?.({ type: "tool_call", toolCallId: "start-transitive/1/2", parentToolCallId: "start-transitive/1", toolName: "edit", input: { path: "blocked.txt" } }, context),
					);
				}
				if (args?.path === "wait-for-abort.txt") {
					await new Promise((resolve) => {
						if (options.signal.aborted) return resolve();
						options.signal.addEventListener("abort", resolve, { once: true });
					});
					call.aborted = true;
					return { toolCall: { id: "aborted" }, isError: true, result: { content: [{ type: "text", text: "manager operation cancelled" }] } };
				}
				if (args?.path === "presentation.txt") {
					options.onUpdate?.({ content: [{ type: "text", text: "partial read result that must be replaced" }], details: { internal: "hidden" }, usage: usage(99, 99) });
					await new Promise((resolve) => setTimeout(resolve, 150));
					const result = { content: [{ type: "text", text: "final read result six red" }], details: { internal: "hidden" }, usage: usage(3, 1) };
					call.usage = result.usage;
					return { toolCall: { id: "presentation" }, isError: false, result };
				}
				if (name === "rich_tool") {
					options.onUpdate?.({ content: [{ type: "text", text: "partial rich result" }] });
					const result = {
						content: [{ type: "text", text: "rich manager result" }, { type: "image", data: "ZmFrZQ==", mimeType: "image/png" }],
						structuredContent: { source: "manager", count: 1 },
						terminate: true,
						usage: usage(3, 1),
					};
					call.usage = result.usage;
					return { toolCall: { id: "rich" }, isError: true, result };
				}
				if (process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO === "concurrent") await new Promise((resolve) => setTimeout(resolve, 40));
				const result = {
					content: [{ type: "text", text: name === "extension_tool" ? "manager extension override" : `manager read override: ${args?.path ?? args?.action ?? "unknown"}` }],
					details: { managerHook: true },
					usage: usage(3, 1),
				};
				call.usage = result.usage;
				return { toolCall: { id: `${name}-${parentExecutions.length}` }, isError: false, result };
			} finally {
				activeParentExecutions--;
			}
		},
	};
	const workload = { investigationUnits: 1, changeUnits: 0, verificationUnits: 1, expectedLongRunningSeconds: 0 };
	const start = registeredTools.get("delegate_engineering");
	const designerStart = registeredTools.get("delegate_designer");
	const control = registeredTools.get("delegate_control");
	assert(start && designerStart && control, "Expected supervised tools to register.");
	// Pi 1.2 must see only the exact requested grant, never a broad or recursive delegation surface.
	assert.equal(typeof start.reachesTools, "function", "Delegation starts must expose reachability metadata.");
	const requestedReachability = ["read", "codemode"];
	const advertisedReachability = start.reachesTools({ tools: requestedReachability });
	assert.deepEqual(advertisedReachability, requestedReachability);
	assert.notStrictEqual(advertisedReachability, requestedReachability, "Reachability must not expose the caller's mutable tool array.");
	assert.deepEqual(start.reachesTools({ tools: ["read", "delegate_control"] }), []);
	assert.deepEqual(start.reachesTools({ tools: ["read", "read"] }), []);
	assert.equal(typeof control.reachesTools, "function", "Delegation controls must expose reachability metadata.");
	assert.deepEqual(control.reachesTools({ jobId: "missing", action: "continue" }), []);
	assert(registeredTools.has("delegate_mechanical") && registeredTools.has("delegate_assistant"), "Expected every worker role to register.");
	const schemaGuidance = registeredTools.get("delegate_mechanical").parameters.properties.tools.description;
	assert.match(schemaGuidance, /codemode.*allowlist.*direct tool.*otherwise omit/i, "Schema guidance no longer describes the codemode delegation rule.");
	for (const name of ["delegate_mechanical", "delegate_assistant", "delegate_engineering", "delegate_designer"]) {
		const delegate = registeredTools.get(name);
		assert.equal(delegate.parameters.properties.tools.description, schemaGuidance, `${name} does not expose shared codemode guidance.`);
		assert(delegate.promptGuidelines.includes(schemaGuidance), `${name} does not expose manager codemode guidance.`);
	}
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	let rendererInvalidations = 0;
	const renderContext = { args: {}, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	const callComponent = start.renderCall({}, theme, renderContext);
	assert.doesNotThrow(() => callComponent.render(80), "Partial streamed arguments must never crash the renderer.");

	// A normal job proves built-in names resolve through the manager context, without merging nested usage into child output.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	let result = await start.execute("start-normal", { task: "fake normal job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.jobId, "engineer-1");
	assert.equal(result.details.model, "fake-provider/active-model");
	assert.equal(result.details.sequence, 1);
	assert.equal(result.details.turns, 1);
	assert.equal(result.details.actionLedger.length, 1);
	assert.equal(result.details.actionLedger[0].mutating, false, "Read-only annotations must classify read as non-mutating.");
	assert.equal(result.usage.input, 10, "Nested manager usage must not be sent back into child accounting.");
	assert.equal(result.usage.output, 2);
	assert.equal(parentExecutions.at(-1).name, "read");
	assert.equal(parentExecutions.at(-1).usage.totalTokens, 4, "The parent manager hook must observe nested usage exactly once.");
	assert.equal(parentExecutions.at(-1).args.path, "package.json", "Built-in name must route through manager override arguments.");
	const partialRender = start.renderResult(result, { expanded: false, isPartial: true }, theme, renderContext).render(100).join("\n");
	assert.match(partialRender, /Last: read package\.json/);
	assert.match(partialRender, /Elapsed:/);
	assert.equal(statusUpdates.at(-1)?.text, "engineer-1 · 11.0%/1k • active-model • medium");
	const resultComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
	renderContext.lastComponent = resultComponent;
	assert.equal(start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext), resultComponent, "The result renderer did not reuse Pi's last component.");
	const firstRender = resultComponent.render(100).join("\n");
	for (let index = 0; index < 100; index++) assert.equal(start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext).render(100).join("\n"), firstRender);
	assert.equal(rendererInvalidations, 0, "A renderer invalidated its own render pass.");
	const normalJobId = result.details.jobId;
	// Only matching continue/revise controls inherit the paused worker's exact grant.
	assert.deepEqual(control.reachesTools({ jobId: normalJobId, action: "continue" }), ["read"]);
	assert.deepEqual(control.reachesTools({ jobId: normalJobId, action: "revise", instructions: "keep scope" }), ["read"]);
	assert.deepEqual(control.reachesTools({ jobId: normalJobId, action: "compact" }), []);
	const managerArgs = { jobId: normalJobId, action: "continue", actionBatches: 1 };
	const managerRenderContext = { args: managerArgs, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	assert.match(control.renderCall(managerArgs, theme, managerRenderContext).render(100).join("\n"), /manager: engineer-1 → continue/);
	result = await control.execute("continue-normal", managerArgs, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.turns, 2);
	assert.equal(result.details.workerText, "deterministic worker complete");
	assert.equal(result.usage.input, 5, "Continuation must return only newly observed usage.");
	assert.equal(result.usage.totalTokens, 8);
	assert.deepEqual(control.reachesTools({ jobId: normalJobId, action: "continue" }), []);

	// Codemode remains local while only the manager-selected non-codemode capability is proxied.
	await writeFile(configPath, JSON.stringify({ designer: { model: "media-provider/media-model", thinking: "high" } }), "utf8");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "codemode";
	result = await designerStart.execute("start-designer", { task: "fake image job", tools: ["read", "codemode"], workload }, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.role, "designer");
	assert.equal(result.details.model, "media-provider/media-model");
	assert.equal(result.details.thinking, "high");
	assert.equal(result.details.actionLedger.length, 2);
	assert.equal(result.details.actionCounts.mutations, 1);
	assert.equal(result.details.recentActions.at(-1).toolName, "codemode");
	assert.deepEqual(result.details.recentActions.at(-1).mediaOutputs, [{ mimeType: "image/png", bytes: 4 }]);
	assert.equal(result.usage.input, 17, "Child-local codemode usage remains child usage; proxied manager usage does not duplicate.");
	assert.equal(result.usage.output, 5);
	result = await control.execute("continue-designer", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(result.details.status, "completed");
	await writeFile(configPath, "{}\n", "utf8");

	// Parent streaming updates replace partial presentation text and preserve the bounded/expanded display contract.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "presentation";
	const presentationUpdates = [];
	result = await start.execute("start-presentation", { task: "fake presentation job", tools: ["read"], workload }, undefined, (update) => presentationUpdates.push(update.details?.presentationText ?? ""), context);
	assert(presentationUpdates.some((text) => text.includes("stream delta that must be replaced")), "Live assistant stream text was not presented.");
	assert(presentationUpdates.some((text) => text.includes("partial read result that must be replaced")), "Manager-proxied streaming update was not presented.");
	assert.equal(result.details.status, "paused");
	assert.match(result.details.presentationText, /authoritative first assistant message/);
	assert.match(result.details.presentationText, /final read result six red/);
	assert.doesNotMatch(result.details.presentationText, /stream delta that must be replaced|stream block that must be replaced|partial read result that must be replaced/);
	const presentationRenderContext = { args: {}, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	const collapsedComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, presentationRenderContext);
	presentationRenderContext.lastComponent = collapsedComponent;
	const collapsed = collapsedComponent.render(100).join("\n");
	assert.match(collapsed, /earlier visual rows omitted/);
	assert.match(collapsed, /final read result six red/);
	result = await control.execute("continue-presentation", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(result.details.status, "completed");
	assert(result.details.workerTextDisplay.length <= 5_000, "Model-facing worker text was not bounded.");
	assert(result.details.presentationText.length > 5_000, "Structured presentation text was unexpectedly bounded.");
	assert.match(result.details.presentationText, /MIDDLE-ONLY-IN-EXPANDED-PRESENTATION/);
	assert.doesNotMatch(result.content[0].text, /MIDDLE-ONLY-IN-EXPANDED-PRESENTATION/);

	// Extension-defined tools are accepted when callable in ctx.tools and expose only the exact selected proxy surface.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "extension";
	result = await start.execute("start-extension", { task: "use extension capability", tools: ["extension_tool"], workload }, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.equal(parentExecutions.at(-1).name, "extension_tool");
	assert.match(result.details.presentationText, /manager extension override/);
	await control.execute("continue-extension", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);

	// Transitive manager calls remain inside the exact selected grant, including through extension tools.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "transitive";
	result = await start.execute("start-transitive", { task: "enforce transitive capabilities", tools: ["extension_tool", "read"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	transitiveDecisions.push(handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "start-transitive/1/3", parentToolCallId: "start-transitive/1", toolName: "read", input: { path: "late.txt" } }, context));
	assert.equal(transitiveDecisions.length, 4);
	assert.equal(transitiveDecisions[0], undefined, "The selected first-level proxy call was blocked.");
	assert.equal(transitiveDecisions[1], undefined, "A selected transitive manager call was blocked.");
	assert.equal(transitiveDecisions[2]?.block, true, "An unselected transitive manager call was not blocked.");
	assert.match(transitiveDecisions[2]?.reason ?? "", /outside this delegation's selected capability grant/i);
	assert.equal(transitiveDecisions[3]?.block, true, "A delayed transitive call survived executor-lease revocation.");
	assert.match(transitiveDecisions[3]?.reason ?? "", /executor lease is no longer active/i);
	await control.execute("continue-transitive", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);

	// Proxy forwarding preserves streamed content, image and structured output, isError, terminate, and strips nested usage/details.
	await clearObservations();
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "proxy-rich";
	result = await start.execute("start-rich", { task: "exercise proxy result transport", tools: ["rich_tool"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.recentActions.at(-1).status, "failed");
	assert.deepEqual(result.details.recentActions.at(-1).mediaOutputs, [{ mimeType: "image/png", bytes: 4 }]);
	const rich = await waitForObservation((entry) => entry.kind === "rich", "rich proxy observation");
	assert.equal(rich.updates, 1);
	assert.equal(rich.hasImage, true);
	assert.deepEqual(rich.structuredContent, { source: "manager", count: 1 });
	assert.equal(rich.isError, true);
	assert.equal(rich.terminate, true);
	assert.equal(rich.hasUsage, false, "Nested usage must be stripped before delivery to the child.");
	await control.execute("continue-rich", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);

	// Multiple child proxy requests can execute concurrently through the manager hook.
	maximumConcurrentParentExecutions = 0;
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "concurrent";
	result = await start.execute("start-concurrent", { task: "run two manager tools", tools: ["read", "extension_tool"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	assert.equal(maximumConcurrentParentExecutions, 2, "Independent proxy requests were serialized instead of using manager execution concurrency.");
	await control.execute("continue-concurrent", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);

	// Reject spoofed job nonces, unknown names, replayed ids, and post-boundary requests without invoking unauthorized manager tools.
	await clearObservations();
	const securityCallsBefore = parentExecutions.length;
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "security";
	result = await start.execute("start-security", { task: "probe private proxy validation", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	const activeSecurity = await waitForObservation((entry) => entry.kind === "security-active", "active security rejections");
	assert.match(activeSecurity.cross, /nonce is invalid/i);
	assert.match(activeSecurity.unknown, /not in this job's selected capability grant/i);
	assert.match(activeSecurity.first, /manager read override: once\.txt/);
	assert.match(activeSecurity.replay, /request id was replayed/i);
	const pausedSecurity = await waitForObservation((entry) => entry.kind === "security-paused", "paused security rejection");
	assert.match(pausedSecurity.text, /no bounded manager executor lease is active/i);
	assert.equal(parentExecutions.length - securityCallsBefore, 1, "Only the first valid security probe may reach ctx.executeTool().");
	await control.execute("continue-security", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);

	// Continuations fail closed if current manager callable definitions no longer match the original grant.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	result = await start.execute("start-revalidate", { task: "revalidate manager definition", tools: ["read"], workload }, undefined, undefined, context);
	const originalReadParameters = managerTools.find((entry) => entry.name === "read").parameters;
	managerTools.find((entry) => entry.name === "read").parameters = { ...originalReadParameters, properties: { ...originalReadParameters.properties, changed: { type: "boolean" } } };
	const revalidated = await control.execute("continue-revalidate", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(revalidated.isError, true);
	assert.equal(revalidated.details.status, "hard_stopped");
	assert.match(revalidated.content[0].text, /manifest revalidation failed/i);
	managerTools.find((entry) => entry.name === "read").parameters = originalReadParameters;
	result = await start.execute("start-revalidate-identity", { task: "revalidate manager identity", tools: ["read"], workload }, undefined, undefined, context);
	const readIndex = managerTools.findIndex((entry) => entry.name === "read");
	const originalReadTool = managerTools[readIndex];
	managerTools[readIndex] = { ...originalReadTool };
	const identityRevalidated = await control.execute("continue-revalidate-identity", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(identityRevalidated.isError, true);
	assert.equal(identityRevalidated.details.status, "hard_stopped");
	assert.match(identityRevalidated.content[0].text, /original callable identity/i);
	managerTools[readIndex] = originalReadTool;

	// Namespace aliases are copied into the proxy manifest and must participate in continuation fingerprints.
	const extensionMetadata = managerMetadata.find((entry) => entry.name === "extension_tool");
	assert(extensionMetadata?.namespace, "Expected extension namespace metadata.");
	const originalExtensionAliases = extensionMetadata.namespace.aliases;
	result = await start.execute("start-revalidate-aliases", { task: "revalidate namespace aliases", tools: ["extension_tool"], workload }, undefined, undefined, context);
	extensionMetadata.namespace.aliases = [...originalExtensionAliases, "changed-alias"];
	const aliasesRevalidated = await control.execute("continue-revalidate-aliases", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(aliasesRevalidated.isError, true);
	assert.equal(aliasesRevalidated.details.status, "hard_stopped");
	assert.match(aliasesRevalidated.content[0].text, /manifest revalidation failed/i);
	extensionMetadata.namespace.aliases = ["extension-alias", 7];
	result = await start.execute("start-invalid-aliases", { task: "reject invalid namespace aliases", tools: ["extension_tool"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /unsupported namespace aliases metadata/i);
	extensionMetadata.namespace.aliases = originalExtensionAliases;

	// Revalidate again at execution time so a replacement during an active lease cannot win a race.
	await clearObservations();
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "identity-race";
	const identityRace = start.execute("start-identity-race", { task: "reject a mid-lease tool replacement", tools: ["read"], workload }, undefined, undefined, context);
	await waitForObservation((entry) => entry.kind === "identity-race-ready", "identity-race worker readiness");
	managerTools[readIndex] = { ...originalReadTool };
	result = await identityRace;
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	assert.match(result.content[0].text, /grant changed before read execution|original callable identity/i);
	managerTools[readIndex] = originalReadTool;

	// Fail closed on non-JSON-safe callable schemas, recursive names, and registered-but-noncallable requests.
	managerTools.find((entry) => entry.name === "read").parameters = { type: "object", invalid: () => undefined };
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	result = await start.execute("start-invalid-schema", { task: "reject unsafe schema", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /not JSON-serializable/i);
	managerTools.find((entry) => entry.name === "read").parameters = originalReadParameters;
	result = await start.execute("start-recursive", { task: "reject recursive delegation", tools: ["delegate_engineering"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /cannot be delegated recursively/i);
	result = await start.execute("start-noncallable", { task: "reject unavailable tool", tools: ["registered_only"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /registered but not callable/i);

	// Existing lifecycle fail-closed paths remain enforced with the manager proxy present.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "length";
	result = await start.execute("start-length", { task: "fake truncated job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	assert.match(result.details.phase, /output limit/i);
	result = await control.execute("continue-length", { jobId: result.details.jobId, action: "continue", actionBatches: 1 }, undefined, undefined, context);
	assert.equal(result.details.status, "completed");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "handled";
	result = await start.execute("start-handled", { task: "fake handled job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /intercepted by an input handler/i);
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "missing-boundary";
	result = await start.execute("start-missing-boundary", { task: "fake missing boundary job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.match(result.content[0].text, /without an enforced IPC boundary/i);
	await writeFile(configPath, JSON.stringify({ policy: { absoluteMaxSeconds: 5, noProgressSeconds: 1 } }), "utf8");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "stats-timeout";
	result = await start.execute("start-stats-timeout", { task: "fake stats timeout job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.notEqual(result.details.status, "paused");
	await writeFile(configPath, JSON.stringify({ policy: { absoluteMaxSeconds: 1, noProgressSeconds: 1 } }), "utf8");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "timeout";
	result = await start.execute("start-timeout", { task: "fake timeout job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	await writeFile(configPath, "{}\n", "utf8");

	// Parent cancellation aborts the nested manager execution and child exit cannot leave a live executor lease.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "cancel-proxy";
	const cancellation = new AbortController();
	const cancellationResult = start.execute("start-cancel-proxy", { task: "cancel nested manager work", tools: ["read"], workload }, cancellation.signal, undefined, context);
	await waitFor(() => parentExecutions.some((call) => call.args?.path === "wait-for-abort.txt"), "nested manager execution start");
	cancellation.abort();
	result = await cancellationResult;
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "cancelled");
	await waitFor(() => parentExecutions.some((call) => call.args?.path === "wait-for-abort.txt" && call.aborted), "nested manager execution abort");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "child-exit";
	result = await start.execute("start-child-exit", { task: "child exits", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert(terminal(result.details.status), "Child exit left a nonterminal worker state.");

	// An already-aborted operation never submits task work, and session shutdown terminates an idle child.
	await rm(promptMarker, { force: true });
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	const alreadyAborted = new AbortController();
	alreadyAborted.abort();
	result = await start.execute("start-aborted", { task: "must not be submitted", tools: ["read"], workload }, alreadyAborted.signal, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "cancelled");
	await assert.rejects(access(promptMarker), /ENOENT/, "An already-aborted operation submitted a prompt.");
	await clearObservations();
	result = await start.execute("start-shutdown", { task: "session cleanup", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.details.status, "paused");
	const workerStart = await waitForObservation((entry) => entry.kind === "worker-start" && Number.isInteger(entry.pid), "session shutdown child identity");
	await handlers.get("session_shutdown")?.({}, context);
	await waitFor(() => {
		try {
			process.kill(workerStart.pid, 0);
			return false;
		} catch {
			return true;
		}
	}, "session shutdown child termination");

	console.log("Deterministic fake-RPC lifecycle and manager-proxy checks passed.");
} finally {
	delete process.env.PI_TASK_DISPATCHER_TEST_MODE;
	delete process.env.PI_TASK_DISPATCHER_CONFIG_PATH;
	delete process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE;
	delete process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER;
	delete process.env.PI_TASK_DISPATCHER_FAKE_OBSERVATION_MARKER;
	delete process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO;
	if (inheritedWorkerRole === undefined) delete process.env.PI_TASK_DISPATCHER_WORKER;
	else process.env.PI_TASK_DISPATCHER_WORKER = inheritedWorkerRole;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
