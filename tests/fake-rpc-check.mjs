/** Exercise WorkerJob lifecycle transitions against a deterministic fake JSONL/IPC child. */

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
const inheritedWorkerRole = process.env.PI_TASK_DISPATCHER_WORKER;

// The test loads the parent extension even when invoked from a delegated review worker.
delete process.env.PI_TASK_DISPATCHER_WORKER;
process.env.PI_TASK_DISPATCHER_TEST_MODE = "1";
process.env.PI_TASK_DISPATCHER_CONFIG_PATH = configPath;
process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE = path.join(projectRoot, "tests", "fake-rpc-worker.mjs");
process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER = promptMarker;

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
	const tools = new Map();
	const handlers = new Map();
	const pi = {
		registerTool(tool) { tools.set(tool.name, tool); },
		getActiveTools() { return ["read", "bash", "edit", "write", "codemode"]; },
		on(event, handler) { handlers.set(event, handler); },
	};
	register(pi);

	const activeModel = { provider: "fake-provider", id: "active-model", contextWindow: 272_000, maxTokens: 128_000 };
	const statusUpdates = [];
	const context = {
		cwd: projectRoot,
		hasUI: true,
		model: activeModel,
		thinkingLevel: "medium",
		ui: {
			theme: { fg(_color, text) { return text; } },
			setWidget() {},
			setStatus(key, text) { statusUpdates.push({ key, text }); },
		},
		modelRegistry: {
			find(provider, id) { return { provider, id, contextWindow: 272_000, maxTokens: 128_000 }; },
			hasConfiguredAuth() { return true; },
		},
	};
	const workload = { investigationUnits: 1, changeUnits: 0, verificationUnits: 1, expectedLongRunningSeconds: 0 };
	const start = tools.get("delegate_engineering");
	const designerStart = tools.get("delegate_designer");
	const control = tools.get("delegate_control");
	assert(start && designerStart && control, "Expected supervised tools to register.");
	assert(tools.has("delegate_mechanical") && tools.has("delegate_assistant"), "Expected every worker role to register.");
	// Validate the shared least-privilege codemode guidance through every registered delegation surface.
	const schemaGuidance = tools.get("delegate_mechanical").parameters.properties.tools.description;
	assert.match(schemaGuidance, /codemode.*allowlist.*direct tool.*otherwise omit/i, "Schema guidance no longer describes the codemode delegation rule.");
	for (const name of ["delegate_mechanical", "delegate_assistant", "delegate_engineering", "delegate_designer"]) {
		const delegate = tools.get(name);
		assert.equal(delegate.parameters.properties.tools.description, schemaGuidance, `${name} does not expose the shared codemode guidance in its tools schema.`);
		assert(delegate.promptGuidelines.includes(schemaGuidance), `${name} does not expose the schema codemode guidance in its manager prompt metadata.`);
	}
	const theme = { fg(_color, text) { return text; }, bold(text) { return text; } };
	let rendererInvalidations = 0;
	const renderContext = { args: {}, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	const callComponent = start.renderCall({}, theme, renderContext);
	assert.doesNotThrow(() => callComponent.render(80), "Partial streamed arguments must never crash the renderer.");

	// A normal fake job must pause, account assistant and tool-result usage once, then resume to completion.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	let result = await start.execute("start-normal", { task: "fake normal job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.jobId, "engineer-1");
	assert.equal(result.details.model, "fake-provider/active-model");
	assert.equal(result.details.sequence, 1);
	assert.equal(result.details.turns, 1);
	assert.equal(result.details.actionLedger.length, 1);
	assert.equal(result.usage.input, 13);
	assert.equal(result.usage.output, 3);
	assert.equal(result.usage.totalTokens, 16);
	const partialRender = start.renderResult(result, { expanded: false, isPartial: true }, theme, renderContext).render(100).join("\n");
	assert.match(partialRender, /Last: read package\.json/);
	assert.match(partialRender, /Elapsed:/);
	assert.equal(statusUpdates.at(-1)?.text, "engineer-1 · 11.0%/1k • active-model • medium");
	const resultComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
	renderContext.lastComponent = resultComponent;
	const reusedResultComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
	assert.equal(reusedResultComponent, resultComponent, "The result renderer did not reuse Pi's last component.");
	const firstRender = reusedResultComponent.render(100).join("\n");
	assert.match(firstRender, /Took:/);
	assert.doesNotMatch(firstRender, /Elapsed:/);
	for (let index = 0; index < 1_000; index++) {
		const repeatedComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
		assert.equal(repeatedComponent.render(100).join("\n"), firstRender, "Repeated render output changed.");
		assert.match(callComponent.render(100).join("\n"), /engineer-1: paused/);
	}
	assert.equal(rendererInvalidations, 0, "A renderer invalidated its own render pass, risking an infinite loop.");
	assert.match(callComponent.render(100).join("\n"), /engineer-1: paused/, "The shared call header did not update to paused.");
	const normalJobId = result.details.jobId;
	const managerArgs = { jobId: normalJobId, action: "continue", actionBatches: 1 };
	const managerRenderContext = { args: managerArgs, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	const managerCall = control.renderCall(managerArgs, theme, managerRenderContext);
	assert.match(managerCall.render(100).join("\n"), /manager: engineer-1 → continue/);
	assert.doesNotMatch(managerCall.render(100).join("\n"), /continue\//);

	result = await control.execute("continue-normal", managerArgs, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.turns, 2);
	assert.equal(result.details.workerText, "deterministic worker complete");
	assert.equal(result.usage.input, 5, "Continuation must return only newly observed usage.");
	assert.equal(result.usage.totalTokens, 8);
	assert.equal(statusUpdates.at(-1)?.text, "engineer-1 · 12.0%/1k • active-model • medium");
	assert(!statusUpdates.some((update) => update.text === undefined), "Worker status must remain visible after it first appears.");
	control.renderResult(result, { expanded: false, isPartial: false }, theme, managerRenderContext).render(100);
	assert.match(managerCall.render(100).join("\n"), /manager: engineer-1 → completed/);
	assert.doesNotMatch(managerCall.render(100).join("\n"), /continue\/completed/);

	// The designer must load only the selected native codemode-only extension and account nested usage once.
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
	assert.match(result.details.recentActions.at(-1).label, /1 image/);
	assert.doesNotMatch(JSON.stringify(result.details), /ZmFrZQ==/, "Snapshots must not retain base64 media payloads.");
	assert.equal(result.usage.input, 20, "Each nested and parent execution must contribute its own pre-merge usage exactly once.");
	assert.equal(result.usage.output, 6);
	assert.equal(result.usage.totalTokens, 26);
	assert.equal(
		statusUpdates.at(-1)?.text,
		"designer-2 · 11.0%/1k • media-model • high | engineer-1 · 12.0%/1k • active-model • medium",
		"Starting another role must retain the previous role's footer status.",
	);
	result = await control.execute(
		"continue-designer",
		{ jobId: result.details.jobId, action: "continue", actionBatches: 1 },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.details.status, "completed");
	assert.match(statusUpdates.at(-1)?.text ?? "", /designer-2.*\|.*engineer-1/);
	await writeFile(configPath, "{}\n", "utf8");

	// Streaming RPC updates must replace their partial text, preserve full UI details, and keep model output bounded.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "presentation";
	const presentationUpdates = [];
	result = await start.execute(
		"start-presentation",
		{ task: "fake presentation job", tools: ["read"], workload },
		undefined,
		(update) => presentationUpdates.push(update.details?.presentationText ?? ""),
		context,
	);
	assert(presentationUpdates.some((text) => text.includes("stream delta that must be replaced")), "Live assistant stream text was not presented.");
	assert(presentationUpdates.some((text) => text.includes("partial read result that must be replaced")), "Live tool partial text was not presented.");
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.match(result.details.presentationText, /authoritative first assistant message/);
	assert.match(result.details.presentationText, /tool start: read presentation\.txt/);
	assert.match(result.details.presentationText, /tool completed: read presentation\.txt/);
	assert.match(result.details.presentationText, /final read result six red/);
	assert.doesNotMatch(result.details.presentationText, /stream delta that must be replaced|stream block that must be replaced|partial read result that must be replaced/);
	assert.doesNotMatch(result.details.presentationText, /\u001b/, "Presentation text must not retain terminal control sequences.");
	const presentationRenderContext = { args: {}, state: {}, invalidate() { rendererInvalidations++; }, cwd: projectRoot };
	const collapsedComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, presentationRenderContext);
	presentationRenderContext.lastComponent = collapsedComponent;
	const collapsed = collapsedComponent.render(100).join("\n");
	assert.match(collapsed, /earlier visual rows omitted/);
	assert.match(collapsed, /to expand/);
	assert.match(collapsed, /final read result six red/);
	assert.doesNotMatch(collapsed, /authoritative first assistant message/, "Collapsed output must retain only the latest visual rows.");

	result = await control.execute(
		"continue-presentation",
		{ jobId: result.details.jobId, action: "continue", actionBatches: 1 },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "completed");
	assert(result.details.workerTextDisplay.length <= 5_000, "Model-facing worker text was not bounded.");
	assert(result.details.presentationText.length > 5_000, "Structured presentation text was unexpectedly bounded.");
	assert.match(result.details.presentationText, /MIDDLE-ONLY-IN-EXPANDED-PRESENTATION/);
	assert.doesNotMatch(result.content[0].text, /MIDDLE-ONLY-IN-EXPANDED-PRESENTATION/, "Model-facing state exposed the omitted middle of a long report.");
	const expandedComponent = control.renderResult(result, { expanded: true, isPartial: false }, theme, presentationRenderContext);
	presentationRenderContext.lastComponent = expandedComponent;
	const expanded = expandedComponent.render(100).join("\n");
	assert.match(expanded, /MIDDLE-ONLY-IN-EXPANDED-PRESENTATION/);
	assert.match(expanded, /latest-presentation-marker/);
	const reusedExpandedComponent = control.renderResult(result, { expanded: true, isPartial: false }, theme, presentationRenderContext);
	assert.equal(reusedExpandedComponent, expandedComponent, "Expanded renderer state was not reused.");
	assert.equal(reusedExpandedComponent.render(100).join("\n"), expanded, "Repeated expanded rendering changed output.");

	// A tool-free output-limit stop must preserve the session so the manager can recover the report.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "length";
	result = await start.execute("start-length", { task: "fake truncated job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "paused");
	assert.equal(result.details.turns, 1);
	assert.equal(result.details.workerText, "truncated worker report");
	assert.match(result.details.phase, /output limit/i);
	assert.match(result.details.recommendation, /continue to recover/i);
	result = await control.execute(
		"continue-length",
		{ jobId: result.details.jobId, action: "continue", actionBatches: 1 },
		undefined,
		undefined,
		context,
	);
	assert.equal(result.isError, false);
	assert.equal(result.details.status, "completed");
	assert.equal(result.details.workerText, "deterministic worker complete");

	// A handled prompt starts no agent run and must fail promptly rather than waiting for settlement.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "handled";
	const handledStartedAt = Date.now();
	result = await start.execute("start-handled", { task: "fake handled job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	assert.match(result.content[0].text, /intercepted by an input handler/i);
	assert(Date.now() - handledStartedAt < 5_000, "Handled prompt should not wait for agent settlement.");

	// A tool-use turn without the private IPC signal must fail closed instead of being mistaken for completion.
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "missing-boundary";
	result = await start.execute("start-missing-boundary", { task: "fake missing boundary job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	assert.match(result.content[0].text, /without an enforced IPC boundary/i);

	// A stats timeout after a valid boundary must remain terminal rather than resurrecting as paused.
	await writeFile(configPath, JSON.stringify({ policy: { absoluteMaxSeconds: 5, noProgressSeconds: 1 } }), "utf8");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "stats-timeout";
	result = await start.execute("start-stats-timeout", { task: "fake stats timeout job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	assert.notEqual(result.details.status, "paused");

	// A silent prompt must terminate the worker at the configured active-time ceiling.
	await writeFile(configPath, JSON.stringify({ policy: { absoluteMaxSeconds: 1, noProgressSeconds: 1 } }), "utf8");
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "timeout";
	const timeoutStartedAt = Date.now();
	result = await start.execute("start-timeout", { task: "fake timeout job", tools: ["read"], workload }, undefined, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "hard_stopped");
	assert.match(result.content[0].text, /(deadline|timed out|closed)/i);
	assert(Date.now() - timeoutStartedAt < 5_000, "Silent prompt should be bounded by test policy.");

	// An already-aborted parent operation may initialize the child but must never submit task work.
	await writeFile(configPath, "{}\n", "utf8");
	await rm(promptMarker, { force: true });
	process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO = "normal";
	const controller = new AbortController();
	controller.abort();
	result = await start.execute("start-aborted", { task: "must not be submitted", tools: ["read"], workload }, controller.signal, undefined, context);
	assert.equal(result.isError, true);
	assert.equal(result.details.status, "cancelled");
	await assert.rejects(access(promptMarker), /ENOENT/, "An already-aborted operation submitted a prompt.");

	await handlers.get("session_shutdown")?.({}, context);
	console.log("Deterministic fake-RPC lifecycle checks passed.");
} finally {
	delete process.env.PI_TASK_DISPATCHER_TEST_MODE;
	delete process.env.PI_TASK_DISPATCHER_CONFIG_PATH;
	delete process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE;
	delete process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER;
	delete process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO;
	if (inheritedWorkerRole === undefined) delete process.env.PI_TASK_DISPATCHER_WORKER;
	else process.env.PI_TASK_DISPATCHER_WORKER = inheritedWorkerRole;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
