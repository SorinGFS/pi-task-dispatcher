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
		getActiveTools() { return ["read", "bash", "edit", "write"]; },
		on(event, handler) { handlers.set(event, handler); },
	};
	register(pi);

	const activeModel = { provider: "fake-provider", id: "active-model", contextWindow: 272_000, maxTokens: 128_000 };
	const context = {
		cwd: projectRoot,
		hasUI: false,
		model: activeModel,
		thinkingLevel: "medium",
		ui: { setWidget() {}, setStatus() {} },
		modelRegistry: {
			find(provider, id) { return { provider, id, contextWindow: 272_000, maxTokens: 128_000 }; },
			hasConfiguredAuth() { return true; },
		},
	};
	const workload = { investigationUnits: 1, changeUnits: 0, verificationUnits: 1, expectedLongRunningSeconds: 0 };
	const start = tools.get("delegate_engineering");
	const control = tools.get("delegate_control");
	assert(start && control, "Expected supervised tools to register.");
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
	assert.match(partialRender, /Elapsed:/);
	const resultComponent = start.renderResult(result, { expanded: false, isPartial: false }, theme, renderContext);
	const firstRender = resultComponent.render(100).join("\n");
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
	control.renderResult(result, { expanded: false, isPartial: false }, theme, managerRenderContext).render(100);
	assert.match(managerCall.render(100).join("\n"), /manager: engineer-1 → completed/);
	assert.doesNotMatch(managerCall.render(100).join("\n"), /continue\/completed/);

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
