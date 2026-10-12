/** Exercise the release extension against a live Pi child, native codemode, and a manager-proxied tool. */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, "..");
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-task-dispatcher-gate-probe-"));
const configPath = path.join(temporaryDirectory, "task-dispatcher.json");
const readProbePath = path.join(temporaryDirectory, "codemode-read-probe.txt");
const marker = "pi-task-dispatcher-manager-proxy-ready";
const inheritedWorkerRole = process.env.PI_TASK_DISPATCHER_WORKER;
let handlers = new Map();

/** Resolve the managed Pi package and CLI without embedding a machine-specific installation path. */
async function resolvePiRuntime() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(homedir(), ".pi", "agent", "install");
	const version = (await readFile(path.join(installRoot, "current-version"), "utf8")).trim();
	const packageRoot = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
	const declaredBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi;
	if (!declaredBin) throw new Error("The managed Pi package does not declare its CLI entry point.");
	return { packageRoot, cliPath: path.resolve(packageRoot, declaredBin) };
}

/** Parse Pi's human-readable model sizes for the dispatcher's formula-only budget metadata. */
function parseSize(value) {
	const match = /^(\d+(?:\.\d+)?)([KMG])?$/i.exec(value ?? "");
	if (!match) return undefined;
	const scale = { K: 1_000, M: 1_000_000, G: 1_000_000_000 }[match[2]?.toUpperCase()] ?? 1;
	return Math.round(Number(match[1]) * scale);
}

/** Select the explicit/active model or the first credential-backed model listed by Pi. */
async function resolveModel(cliPath) {
	const { stdout } = await executeFile(process.execPath, [cliPath, "--list-models"], { maxBuffer: 8 * 1024 * 1024 });
	const rows = stdout.split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((columns) => columns.length >= 4);
	const requested = process.env.PI_TASK_DISPATCHER_GATE_MODEL
		?? (process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : undefined);
	const selected = requested
		? rows.find(([provider, id]) => `${provider}/${id}` === requested)
		: rows[0];
	if (!selected && !requested) throw new Error("Pi did not list an available model for the live gate probe.");
	const [provider, id] = requested ? requested.split(/\/(.+)/) : selected;
	if (!provider || !id) throw new Error(`Invalid gate model: ${requested}`);
	return {
		provider,
		id,
		contextWindow: parseSize(selected?.[2]) ?? 272_000,
		maxTokens: parseSize(selected?.[3]) ?? 128_000,
	};
}

try {
	const { packageRoot: piRoot, cliPath } = await resolvePiRuntime();
	const model = await resolveModel(cliPath);
	await writeFile(configPath, "{}\n", "utf8");
	await writeFile(readProbePath, `${marker}\n`, "utf8");

	// Load the release source while directing only its child-process lookup and configuration to the probe.
	delete process.env.PI_TASK_DISPATCHER_WORKER;
	process.env.PI_TASK_DISPATCHER_TEST_MODE = "1";
	process.env.PI_TASK_DISPATCHER_CONFIG_PATH = configPath;
	process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE = cliPath;
	const requireFromPi = createRequire(path.join(piRoot, "package.json"));
	const { createJiti } = requireFromPi("jiti");
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
	handlers = new Map();
	const readTool = {
		name: "read",
		label: "Read",
		description: "Read one UTF-8 text file through the live gate manager.",
		parameters: {
			type: "object",
			additionalProperties: false,
			required: ["path"],
			properties: { path: { type: "string" } },
		},
		executionMode: "parallel",
	};
	const codemodeTool = {
		name: "codemode",
		label: "Codemode",
		description: "Run child-local codemode.",
		parameters: { type: "object", properties: { code: { type: "string" } } },
		executionMode: "sequential",
	};
	const managerTools = [readTool, codemodeTool];
	const pi = {
		registerTool(tool) { registeredTools.set(tool.name, tool); },
		getActiveTools() { return managerTools.map((tool) => tool.name); },
		getAllTools() {
			return managerTools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				exposure: "direct",
				annotations: { readOnlyHint: tool.name === "read" },
				promptGuidelines: [],
				sourceInfo: { path: `<gate:${tool.name}>`, source: "gate", scope: "temporary", origin: "top-level", baseDir: undefined },
			}));
		},
		on(event, handler) {
			const entries = handlers.get(event) ?? [];
			entries.push(handler);
			handlers.set(event, entries);
		},
	};
	register(pi);

	const managerCalls = [];
	const context = {
		cwd: projectRoot,
		hasUI: false,
		model,
		thinkingLevel: process.env.PI_TASK_DISPATCHER_GATE_THINKING ?? process.env.PI_REASONING_LEVEL ?? "medium",
		get tools() { return managerTools.filter((tool) => tool.name !== "codemode"); },
		ui: { theme: { fg(_color, text) { return text; } }, setWidget() {}, setStatus() {} },
		modelRegistry: {
			find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
			hasConfiguredAuth() { return true; },
		},
		async executeTool(name, args, options) {
			managerCalls.push({ name, args });
			if (name !== "read") {
				return { toolCall: { id: "gate-denied", name, arguments: args }, isError: true, result: { content: [{ type: "text", text: `Unexpected manager tool: ${name}` }], details: undefined } };
			}
			options?.onUpdate?.({ content: [{ type: "text", text: "manager read in progress" }], details: undefined });
			try {
				const text = await readFile(args.path, "utf8");
				return { toolCall: { id: "gate-read", name, arguments: args }, isError: false, result: { content: [{ type: "text", text }], details: undefined } };
			} catch (error) {
				return { toolCall: { id: "gate-read", name, arguments: args }, isError: true, result: { content: [{ type: "text", text: String(error) }], details: undefined } };
			}
		},
	};
	const start = registeredTools.get("delegate_engineering");
	const control = registeredTools.get("delegate_control");
	assert(start && control, "The release extension did not register its engineering/control tools.");
	const workload = { investigationUnits: 1, changeUnits: 0, verificationUnits: 1, expectedLongRunningSeconds: 0 };
	const startAbort = new AbortController();
	const startTimer = setTimeout(() => startAbort.abort(), 180_000);
	let result;
	try {
		result = await start.execute(
			"gate-start",
			{
				task: `Call codemode exactly once. In its JavaScript source, call await tools.read({ path: ${JSON.stringify(readProbePath)} }); verify the returned text contains ${marker}, then call text(${JSON.stringify(marker)}). Do not call tools directly or make any other tool calls. After that action batch, report only the marker.`,
				tools: ["read", "codemode"],
				workload,
			},
			startAbort.signal,
			undefined,
			context,
		);
	} finally {
		clearTimeout(startTimer);
	}
	assert.equal(result.isError, false, result.content?.[0]?.text);
	assert.equal(result.details.status, "paused", result.content?.[0]?.text);
	assert.deepEqual(managerCalls, [{ name: "read", args: { path: readProbePath } }], "The child did not use the exact manager-proxied read grant once.");
	assert(result.details.actionLedger.some((action) => action.toolName === "codemode"), "The live child did not execute native codemode.");
	assert(result.details.actionLedger.some((action) => action.toolName === "read" && action.parentToolCallId), "Codemode did not execute read through the child proxy.");

	const continueAbort = new AbortController();
	const continueTimer = setTimeout(() => continueAbort.abort(), 180_000);
	try {
		result = await control.execute(
			"gate-control",
			{ jobId: result.details.jobId, action: "revise", instructions: `Do not call tools. Report only ${marker}.`, actionBatches: 1 },
			continueAbort.signal,
			undefined,
			context,
		);
	} finally {
		clearTimeout(continueTimer);
	}
	assert.equal(result.isError, false, result.content?.[0]?.text);
	assert.equal(result.details.status, "completed", result.content?.[0]?.text);
	assert.match(result.details.workerText, new RegExp(marker));
	console.log(JSON.stringify({
		model: `${model.provider}/${model.id}`,
		status: result.details.status,
		managerProxyCalls: managerCalls.length,
		nativeCodemode: true,
		finalText: result.details.workerText,
	}, null, 2));
} finally {
	for (const handler of handlers.get("session_shutdown") ?? []) await handler();
	delete process.env.PI_TASK_DISPATCHER_TEST_MODE;
	delete process.env.PI_TASK_DISPATCHER_CONFIG_PATH;
	delete process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE;
	if (inheritedWorkerRole === undefined) delete process.env.PI_TASK_DISPATCHER_WORKER;
	else process.env.PI_TASK_DISPATCHER_WORKER = inheritedWorkerRole;
	await rm(temporaryDirectory, { recursive: true, force: true });
}
