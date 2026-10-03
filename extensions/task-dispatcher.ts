/**
 * Exposes two bounded delegation tools that run configurable worker models in isolated Pi processes.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type ExtensionAPI, type ExtensionToolContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Role = "mechanic" | "engineer";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type WorkerStatus =
	| "running"
	| "completed"
	| "configuration_error"
	| "model_error"
	| "process_error"
	| "aborted"
	| "timeout"
	| "turn_limit"
	| "incomplete";

interface WorkerConfig {
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	timeoutSeconds: number;
	maxTurns: number;
}

interface DispatcherConfig {
	mechanic: WorkerConfig;
	engineer: WorkerConfig;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheWrite1h?: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface WorkerDetails {
	role: Role;
	status: WorkerStatus;
	model: string;
	thinking: ThinkingLevel;
	tools: string[];
	turns: number;
	durationMs: number;
	exitCode: number | null;
	stopReason?: string;
	diagnostic?: string;
	stderr?: string;
	activity: string[];
}

interface WorkerResult {
	output: string;
	details: WorkerDetails;
	usage?: UsageTotals;
}

interface ParsedEvent {
	type?: string;
	message?: {
		role?: string;
		content?: Array<{ type?: string; text?: string; name?: string; arguments?: unknown }>;
		usage?: Partial<UsageTotals> & { cost?: Partial<UsageTotals["cost"]> };
		stopReason?: string;
		errorMessage?: string;
	};
	toolName?: string;
	args?: unknown;
}

type EventUsage = NonNullable<NonNullable<ParsedEvent["message"]>["usage"]>;

const CONFIG_PATH = path.join(getAgentDir(), "task-dispatcher.json");
const WORKER_ENV = "PI_TASK_DISPATCHER_WORKER";
const RESULT_LIMIT = 24_000;
const STDERR_LIMIT = 8_000;
const DEFAULT_TOOLS = [
	"read",
	"bash",
	"edit",
	"write",
];
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const DEFAULT_CONFIG: DispatcherConfig = {
	mechanic: {
		model: "openai-codex/gpt-5.6-luna",
		thinking: "max",
		tools: DEFAULT_TOOLS,
		timeoutSeconds: 300,
		maxTurns: 20,
	},
	engineer: {
		model: "openai-codex/gpt-5.6-terra",
		thinking: "max",
		tools: DEFAULT_TOOLS,
		timeoutSeconds: 900,
		maxTurns: 30,
	},
};

const ROLE_PROMPTS: Record<Role, string> = {
	mechanic: `You are the mechanical worker in a delegated Pi task.
Complete the supplied task directly with the available tools. The caller has retained ownership of the surrounding task.

Rules:
- Treat the delegated task as the complete scope. Do not invent missing requirements or broaden it.
- Inspect before modifying and preserve existing project conventions.
- Perform exact, repetitive, retrieval, transformation, command, and verification work autonomously.
- If a semantic, architectural, or user-intent decision is required, stop and report precisely what is blocked.
- Run requested checks. Never claim a check passed unless you observed it pass.
- Report partial changes after any failure.
- Finish with a concise report containing status, files changed, checks run, and anything unresolved.`,
	engineer: `You are the engineering worker in a delegated Pi task.
Own the supplied subtask autonomously while the caller retains integration and final-response responsibility.

Rules:
- Treat the delegated objective, constraints, and acceptance conditions as authoritative.
- Inspect the relevant code and project instructions before changing it.
- You may investigate, research, reason, implement, refactor, test, and make local engineering decisions needed to complete the subtask.
- Keep work relevant to the delegated outcome. If completion requires materially changing its objective or constraints, stop and explain the needed decision.
- Run appropriate checks. Never claim a check passed unless you observed it pass.
- Report partial changes after any failure.
- Finish with a concise report containing the outcome, files changed, checks run, local decisions, and anything unresolved.`,
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
	mechanic:
		"Delegate a bounded mechanical episode to the configured mechanic model. Use when the desired outcome and constraints can be stated precisely and the work is primarily file inspection, exact edits, repetitive transformations, commands, retrieval, or verification. Prefer this for multi-step work or bulky intermediate output; use a direct tool for one trivial operation. The worker operates in the current workspace and may modify files.",
	engineer:
		"Delegate any self-contained engineering subtask to the configured engineer model. Use broadly for investigation, implementation, debugging, refactoring, testing, review, research, or analysis that can be given a clear outcome and returned for integration. Include all relevant constraints and acceptance conditions. The worker operates in the current workspace and may modify files.",
};

const DelegateParams = Type.Object({
	task: Type.String({
		minLength: 1,
		maxLength: 12_000,
		description: "A self-contained task with its objective, scope, constraints, and completion checks.",
	}),
});

/** Identify plain objects before reading user-controlled JSON configuration fields. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy defaults so loaded configuration cannot mutate shared role settings. */
function copyWorkerConfig(config: WorkerConfig): WorkerConfig {
	return { ...config, tools: [...config.tools] };
}

/** Validate and merge one role's optional configuration over its package defaults. */
function parseWorkerConfig(role: Role, value: unknown): WorkerConfig {
	const result = copyWorkerConfig(DEFAULT_CONFIG[role]);
	if (value === undefined) return result;
	if (!isRecord(value)) throw new Error(`"${role}" must be an object`);

	// Validate the exact model identity used for deterministic dispatch.
	if (value.model !== undefined) {
		if (typeof value.model !== "string" || !value.model.includes("/")) {
			throw new Error(`"${role}.model" must be a provider/model string`);
		}
		result.model = value.model;
	}

	// Accept only thinking levels supported by Pi's public CLI contract.
	if (value.thinking !== undefined) {
		if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking as ThinkingLevel)) {
			throw new Error(`"${role}.thinking" is not a valid Pi thinking level`);
		}
		result.thinking = value.thinking as ThinkingLevel;
	}

	// Require an explicit non-empty allowlist when tools are overridden.
	if (value.tools !== undefined) {
		if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.some((tool) => typeof tool !== "string" || !tool.trim())) {
			throw new Error(`"${role}.tools" must be a non-empty array of tool names`);
		}
		result.tools = [...new Set(value.tools as string[])];
	}

	// Bound worker lifetime settings to positive integers.
	for (const field of ["timeoutSeconds", "maxTurns"] as const) {
		const candidate = value[field];
		if (candidate !== undefined) {
			if (!Number.isInteger(candidate) || (candidate as number) <= 0) {
				throw new Error(`"${role}.${field}" must be a positive integer`);
			}
			result[field] = candidate as number;
		}
	}

	return result;
}

/** Load the optional personal configuration afresh for every delegation. */
function loadConfig(): DispatcherConfig {
	if (!fs.existsSync(CONFIG_PATH)) {
		return {
			mechanic: copyWorkerConfig(DEFAULT_CONFIG.mechanic),
			engineer: copyWorkerConfig(DEFAULT_CONFIG.engineer),
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
	} catch (error) {
		throw new Error(`Cannot parse ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(parsed)) throw new Error(`${CONFIG_PATH} must contain a JSON object`);
	if (parsed.version !== undefined && parsed.version !== 1) {
		throw new Error(`${CONFIG_PATH} has unsupported version ${String(parsed.version)}`);
	}

	return {
		mechanic: parseWorkerConfig("mechanic", parsed.mechanic),
		engineer: parseWorkerConfig("engineer", parsed.engineer),
	};
}

/** Resolve the currently running Pi entry point so workers use the same local installation. */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(executable)) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

/** Create a zeroed Pi usage object for aggregation into the parent tool result. */
function emptyUsage(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Add one assistant response's reported usage to the worker total. */
function addUsage(total: UsageTotals, usage: EventUsage | undefined): void {
	if (!usage) return;
	total.input += usage.input ?? 0;
	total.output += usage.output ?? 0;
	total.cacheRead += usage.cacheRead ?? 0;
	total.cacheWrite += usage.cacheWrite ?? 0;
	total.totalTokens += usage.totalTokens ?? 0;
	if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
	if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
	total.cost.input += usage.cost?.input ?? 0;
	total.cost.output += usage.cost?.output ?? 0;
	total.cost.cacheRead += usage.cost?.cacheRead ?? 0;
	total.cost.cacheWrite += usage.cost?.cacheWrite ?? 0;
	total.cost.total += usage.cost?.total ?? 0;
}

/** Keep model-facing worker output within a predictable context budget. */
function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n\n[Output truncated: ${text.length - limit} characters omitted.]`;
}

/** Render a compact activity label from a worker tool call. */
function formatActivity(name: string, args: unknown): string {
	if (name === "bash" && isRecord(args) && typeof args.command === "string") {
		return `$ ${truncate(args.command, 120)}`;
	}
	if (isRecord(args) && typeof args.path === "string") return `${name} ${args.path}`;
	return name;
}

/** Run one isolated Pi worker through its full tool-using agent loop. */
async function runWorker(
	role: Role,
	task: string,
	config: WorkerConfig,
	cwd: string,
	signal: AbortSignal | undefined,
	onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: WorkerDetails }) => void) | undefined,
): Promise<WorkerResult> {
	const startedAt = Date.now();
	const usage = emptyUsage();
	const activity: string[] = [];
	let turns = 0;
	let finalOutput = "";
	let stopReason: string | undefined;
	let modelError: string | undefined;
	let stderr = "";
	let forcedStatus: WorkerStatus | undefined;
	let processError: string | undefined;

	// Keep role instructions out of the command line and remove them after the worker exits.
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-dispatcher-"));

	try {
		const promptPath = path.join(tempDir, `${role}.md`);
		await fs.promises.writeFile(promptPath, ROLE_PROMPTS[role], { encoding: "utf8", mode: 0o600 });

		const args = [
			"--mode",
			"json",
			"-p",
			"--no-session",
			"--model",
			config.model,
			"--thinking",
			config.thinking,
			"--tools",
			config.tools.join(","),
			"--append-system-prompt",
			promptPath,
			`Delegated ${role} task:\n${task}`,
		];

		const exitCode = await new Promise<number | null>((resolve) => {
			const invocation = getPiInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, [WORKER_ENV]: role },
			});
			let stdoutBuffer = "";
			let unfinishedUsage: EventUsage | undefined;
			const stdoutDecoder = new TextDecoder("utf-8");
			const stderrDecoder = new TextDecoder("utf-8");
			let settled = false;
			let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

			// Stop the process once and escalate to a forceful kill if it does not exit.
			const stopChild = (status: WorkerStatus) => {
				if (forcedStatus) return;
				forcedStatus = status;
				child.kill("SIGTERM");
				forceKillTimer = setTimeout(() => {
					if (!settled) child.kill("SIGKILL");
				}, 5_000);
			};

			// Retain in-flight usage while treating completed messages as authoritative.
			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: ParsedEvent;
				try {
					event = JSON.parse(line) as ParsedEvent;
				} catch {
					return;
				}
				if (event.type === "message_update") {
					if (event.message?.usage) unfinishedUsage = event.message.usage;
					return;
				}
				if (event.type !== "message_end" || event.message?.role !== "assistant") return;

				turns++;
				stopReason = event.message.stopReason ?? stopReason;
				modelError = event.message.errorMessage ?? modelError;
				addUsage(usage, event.message.usage ?? unfinishedUsage);
				unfinishedUsage = undefined;

				// Preserve the latest final text and surface worker tool activity as progress.
				for (const part of event.message.content ?? []) {
					if (part.type === "text" && part.text) finalOutput = part.text;
					if (part.type === "toolCall" && part.name) {
						const label = formatActivity(part.name, part.arguments);
						activity.push(label);
						onUpdate?.({
							content: [{ type: "text", text: `${role}: ${label}` }],
							details: {
								role,
								status: "running",
								model: config.model,
								thinking: config.thinking,
								tools: config.tools,
								turns,
								durationMs: Date.now() - startedAt,
								exitCode: null,
								activity: [...activity],
							},
						});
					}
				}

				if (turns >= config.maxTurns && stopReason === "toolUse") stopChild("turn_limit");
			};

			// Stream-decode UTF-8 before splitting complete JSONL records, retaining a trailing fragment.
			child.stdout.on("data", (chunk) => {
				stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
				const lines = stdoutBuffer.split("\n");
				stdoutBuffer = lines.pop() ?? "";
				// Forward each complete event record to the worker-state reducer.
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk) => {
				stderr = truncate(stderr + stderrDecoder.decode(chunk, { stream: true }), STDERR_LIMIT);
			});
			child.on("error", (error) => {
				processError = error.message;
			});
			// Flush decoder state and charge at most one unfinished streamed assistant response.
			child.on("close", (code) => {
				settled = true;
				if (forceKillTimer) clearTimeout(forceKillTimer);
				stdoutBuffer += stdoutDecoder.decode();
				stderr = truncate(stderr + stderrDecoder.decode(), STDERR_LIMIT);
				if (stdoutBuffer.trim()) processLine(stdoutBuffer);
				if (unfinishedUsage) addUsage(usage, unfinishedUsage);
				resolve(code);
			});

			const timeout = setTimeout(() => stopChild("timeout"), config.timeoutSeconds * 1_000);
			child.once("close", () => clearTimeout(timeout));

			// Propagate cancellation from the parent Pi turn to the worker process.
			if (signal) {
				const abort = () => stopChild("aborted");
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
				child.once("close", () => signal.removeEventListener("abort", abort));
			}
		});

		let status: WorkerStatus = "completed";
		if (forcedStatus) status = forcedStatus;
		else if (processError || exitCode !== 0) status = "process_error";
		else if (stopReason === "error") status = "model_error";
		else if (stopReason === "aborted") status = "aborted";
		else if (stopReason && stopReason !== "stop") status = "incomplete";
		else if (!finalOutput.trim()) status = "incomplete";

		// Put failure context ahead of output emitted before the worker reached a completed state.
		const partialOutput = finalOutput.trim();
		const stderrOutput = stderr.trim();
		const statusDiagnostic =
			status === "timeout"
				? `Worker timed out after ${config.timeoutSeconds} seconds.`
				: status === "turn_limit"
					? `Worker reached the configured ${config.maxTurns}-turn limit.`
					: status === "aborted"
						? "Worker was aborted."
						: status === "process_error"
							? `Worker process exited with code ${exitCode ?? "unknown"}.`
							: status === "model_error"
								? "Worker model returned an error."
								: `Worker did not complete${stopReason ? ` (stop reason: ${stopReason})` : ""}.`;
		const diagnostic =
			status === "completed" ? undefined : modelError || processError || stderrOutput || statusDiagnostic;
		const output =
			status !== "completed" && diagnostic
				? `${diagnostic}${partialOutput ? `\n\n${partialOutput}` : ""}`
				: partialOutput || stderrOutput || "The worker produced no final report.";
		return {
			output: truncate(output, RESULT_LIMIT),
			details: {
				role,
				status,
				model: config.model,
				thinking: config.thinking,
				tools: config.tools,
				turns,
				durationMs: Date.now() - startedAt,
				exitCode,
				stopReason,
				diagnostic,
				stderr: stderrOutput || undefined,
				activity,
			},
			usage,
		};
	} finally {
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	}
}

/** Confirm that a configured physical model exists and has credentials before spawning a worker. */
function validateModel(config: WorkerConfig, ctx: ExtensionToolContext): void {
	const separator = config.model.indexOf("/");
	const provider = config.model.slice(0, separator);
	const modelId = config.model.slice(separator + 1);
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`Configured model ${config.model} was not found. Configuration: ${CONFIG_PATH}`);
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
		throw new Error(`Configured model ${config.model} has no usable authentication. Configuration: ${CONFIG_PATH}`);
	}
}

/** Register one role-specific public tool over the shared worker executor. */
function registerDelegate(pi: ExtensionAPI, role: Role): void {
	const toolName = role === "mechanic" ? "delegate_mechanical" : "delegate_engineering";
	pi.registerTool({
		name: toolName,
		label: role === "mechanic" ? "Delegate Mechanical" : "Delegate Engineering",
		description: ROLE_DESCRIPTIONS[role],
		promptSnippet: `${toolName}: dispatch a self-contained ${role} subtask to an isolated configured worker model`,
		promptGuidelines: [
			role === "mechanic"
				? "Use delegate_mechanical for bounded multi-step execution with precise desired results; give it a self-contained contract and integrate its report."
				: "Use delegate_engineering broadly for self-contained investigation or production work; give it the outcome, constraints, and acceptance conditions, then integrate its report.",
			"Delegation results are worker reports, not proof of correctness; inspect material changes and retain responsibility for the final answer.",
		],
		parameters: DelegateParams,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			let config: WorkerConfig;
			try {
				config = loadConfig()[role];
				validateModel(config, ctx);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Cannot start ${role} worker: ${message}` }],
					details: {
						role,
						status: "configuration_error" as const,
						model: "",
						thinking: "off" as const,
						tools: [],
						turns: 0,
						durationMs: 0,
						exitCode: null,
						diagnostic: message,
						activity: [],
					},
					isError: true,
				};
			}

			const result = await runWorker(role, params.task, config, ctx.cwd, signal, onUpdate);
			const heading = `${role} worker ${result.details.status} via ${result.details.model} (${result.details.thinking})`;
			return {
				content: [{ type: "text", text: `${heading}\n\n${result.output}` }],
				details: result.details,
				usage: result.usage,
				isError: result.details.status !== "completed",
			};
		},
	});
}

/** Register only in the parent process; workers receive an explicit non-recursive tool allowlist. */
export default function taskDispatcher(pi: ExtensionAPI): void {
	if (process.env[WORKER_ENV]) return;
	registerDelegate(pi, "mechanic");
	registerDelegate(pi, "engineer");
}
