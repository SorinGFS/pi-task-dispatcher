/**
 * Verify supervised codemode loading and a reusable worker-side boundary after one completed tool batch.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

// Resolve the managed Pi release without embedding a machine-specific installation path.
async function resolvePiCli() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(homedir(), ".pi", "agent", "install");
	const version = (await readFile(path.join(installRoot, "current-version"), "utf8")).trim();
	const packageRoot = path.join(installRoot, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
	const packageJson = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
	const declaredBin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin?.pi;
	if (!declaredBin) throw new Error("The managed Pi package does not declare its CLI entry point.");
	return path.resolve(packageRoot, declaredBin);
}

const cliPath = await resolvePiCli();
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "pi-task-dispatcher-gate-probe-"));
const gatePath = path.join(temporaryDirectory, "gate.ts");
let child;

try {
	// Abort the active worker run only after its complete tool batch has been persisted.
	await writeFile(
		gatePath,
		`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
	pi.on("turn_end", async (event, ctx) => {
		if (event.toolResults.length === 0) return;
		if (typeof process.send === "function") process.send({
			type: "task_dispatcher_boundary",
			turnIndex: event.turnIndex,
			toolResults: event.toolResults.length,
		});
		ctx.abort();
	});
}
`,
		"utf8",
	);

	// Prefer explicit test overrides, then the active parent Pi model exported in PI_* variables.
	const activeModel = process.env.PI_TASK_DISPATCHER_GATE_MODEL
		?? (process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : undefined);
	const activeThinking = process.env.PI_TASK_DISPATCHER_GATE_THINKING ?? process.env.PI_REASONING_LEVEL;
	const workerArgs = [
		cliPath,
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
		"--tools",
		"codemode",
		"--extension",
		"builtin:codemode",
		"--extension",
		gatePath,
	];
	if (activeModel) workerArgs.push("--model", activeModel);
	if (activeThinking) workerArgs.push("--thinking", activeThinking);

	child = spawn(
		process.execPath,
		workerArgs,
		{
			cwd: path.resolve(import.meta.dirname, ".."),
			stdio: ["pipe", "pipe", "pipe", "ipc"],
			env: { ...process.env, PI_TASK_DISPATCHER_WORKER: "probe" },
		},
	);

	const events = [];
	const boundaries = [];
	let stderr = "";
	let settledResolve;
	let settled = new Promise((resolve) => {
		settledResolve = resolve;
	});

	// Collect public RPC events independently from the private boundary signal.
	readline.createInterface({ input: child.stdout }).on("line", (line) => {
		if (!line.trim()) return;
		const event = JSON.parse(line);
		events.push(event);
		if (event.type === "agent_settled") settledResolve();
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.on("message", (message) => boundaries.push(message));

	// Run one codemode batch and require the gate to settle before a productive follow-up turn.
	child.stdin.write(`${JSON.stringify({
		id: "probe-1",
		type: "prompt",
		message: "Call codemode exactly once with the raw JavaScript source: text('pi-task-dispatcher-codemode-ready')\nDo not use any other tool and do not add other script statements.",
	})}\n`);
	await Promise.race([
		settled,
		new Promise((_, reject) => setTimeout(() => reject(new Error("First gated run did not settle.")), 120_000)),
	]);

	const firstAssistantMessages = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
	const firstBoundaryCount = boundaries.filter((message) => message?.type === "task_dispatcher_boundary").length;
	if (firstBoundaryCount !== 1) throw new Error(`Expected one private boundary, observed ${firstBoundaryCount}.`);
	if (!firstAssistantMessages.some((event) => event.message?.stopReason === "toolUse")) {
		throw new Error("The first run did not execute the expected tool-use turn.");
	}
	if (!events.some((event) => event.type === "tool_execution_end" && event.toolName === "codemode" && !event.isError)) {
		throw new Error("The isolated worker did not complete the selected built-in codemode tool.");
	}

	// Continue in the same in-memory RPC session and require a normal final answer without another tool batch.
	events.length = 0;
	settled = new Promise((resolve) => {
		settledResolve = resolve;
	});
	child.stdin.write(`${JSON.stringify({
		id: "probe-2",
		type: "prompt",
		message: "Continue from the completed codemode result. Do not call tools. Report only the exact marker produced by the script.",
	})}\n`);
	await Promise.race([
		settled,
		new Promise((_, reject) => setTimeout(() => reject(new Error("Continuation run did not settle.")), 120_000)),
	]);

	const finalText = events
		.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
		.flatMap((event) => event.message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!finalText.includes("pi-task-dispatcher-codemode-ready")) throw new Error(`Unexpected continuation output: ${finalText}`);

	console.log(JSON.stringify({ firstBoundaryCount, firstAssistantMessages: firstAssistantMessages.length, finalText }, null, 2));
	if (stderr.trim()) console.error(stderr.trim());
} finally {
	// Close the reusable child and remove only the runtime-controlled probe directory.
	if (child && child.exitCode === null && child.signalCode === null) {
		child.stdin?.end();
		await Promise.race([
			new Promise((resolve) => child.once("close", resolve)),
			new Promise((resolve) => setTimeout(resolve, 5_000)),
		]);
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	}
	await rm(temporaryDirectory, { recursive: true, force: true });
}
