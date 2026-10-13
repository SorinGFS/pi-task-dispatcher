/**
 * Runs delegated Pi workers as supervised, resumable jobs that pause after each completed tool batch.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionToolContext,
	getAgentDir,
	keyHint,
	truncateToVisualLines,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type Role = "mechanic" | "assistant" | "engineer" | "designer";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type JobStatus =
	| "starting"
	| "running"
	| "paused"
	| "compacting"
	| "completed"
	| "checkpointed"
	| "taken_over"
	| "cancelled"
	| "hard_stopped"
	| "failed";
interface WorkerRoleConfig {
	model?: string;
	thinking?: ThinkingLevel;
}

interface ResolvedWorkerRoleConfig {
	model: string;
	thinking: ThinkingLevel;
}

interface DispatcherPolicy {
	absoluteMaxTurns: number;
	absoluteMaxSeconds: number;
	pausedLeaseSeconds: number;
	noProgressSeconds: number;
}

type DispatcherConfig = Record<Role, WorkerRoleConfig> & {
	policy: DispatcherPolicy;
};

interface Workload {
	investigationUnits: number;
	changeUnits: number;
	verificationUnits: number;
	expectedLongRunningSeconds: number;
}

interface CalculatedBudget {
	workload: Workload;
	turns: number;
	seconds: number;
	contextWindow: number;
	maxOutputTokens: number;
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

interface WorkerMediaOutput {
	mimeType: string;
	bytes: number;
}

interface WorkerAction {
	sequence: number;
	toolCallId: string;
	toolName: string;
	label: string;
	mutating: boolean;
	status: "running" | "completed" | "failed";
	startedAt: number;
	endedAt?: number;
	completionSequence?: number;
	parentToolCallId?: string;
	mediaOutputs?: WorkerMediaOutput[];
}

/** Keep one replaceable presentation record for each assistant response or child tool lifecycle. */
interface WorkerPresentationEntry {
	id: string;
	kind: "assistant" | "tool";
	label: string;
	status: "streaming" | "running" | "completed" | "failed";
	text: string;
	parentToolCallId?: string;
}

interface ContextMetrics {
	tokens?: number;
	contextWindow: number;
	percent?: number;
	peakPercent: number;
	compactionAttempts: number;
	compactions: number;
	compactionSkips: number;
	compactionFailures: number;
}

interface WorkerSnapshot {
	jobId: string;
	role: Role;
	status: JobStatus;
	model: string;
	thinking: ThinkingLevel;
	sequence: number;
	phase: string;
	recommendation: string;
	taskDisplay: string;
	currentActivity?: string;
	managerAction?: string;
	turns: number;
	durationMs: number;
	budget: CalculatedBudget;
	context: ContextMetrics;
	actionCounts: {
		total: number;
		completed: number;
		failed: number;
		mutations: number;
	};
	recentActions: WorkerAction[];
	actionLedger: WorkerAction[];
	workerText: string;
	/** Complete sanitized delegate activity retained only in structured tool details for UI expansion. */
	presentationText: string;
	workerTextDisplay: string;
	workerTextTruncated: boolean;
	diagnostic?: string;
	tools: string[];
	usage: UsageTotals;
}

/** Retain only RPC content fields needed for text presentation and image metadata extraction. */
interface RpcContent {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Model the result fields shared by partial and authoritative tool RPC events. */
interface RpcToolResult {
	content?: RpcContent[];
	usage?: EventUsage;
	estimatedTokensAfter?: number;
}

interface ParsedEvent {
	id?: string;
	type?: string;
	command?: string;
	success?: boolean;
	disposition?: string;
	error?: string;
	data?: unknown;
	reason?: string;
	aborted?: boolean;
	errorMessage?: string;
	willRetry?: boolean;
	result?: RpcToolResult;
	partialResult?: RpcToolResult;
	message?: {
		role?: string;
		content?: RpcContent[];
		usage?: EventUsage;
		stopReason?: string;
		errorMessage?: string;
	};
	usage?: EventUsage;
	assistantMessageEvent?: {
		type?: string;
		contentIndex?: number;
		delta?: string;
		content?: string;
	};
	toolCallId?: string;
	toolName?: string;
	parentToolCallId?: string;
	args?: unknown;
	isError?: boolean;
	durationMs?: number;
}

interface GateBoundaryMessage {
	type: "task_dispatcher_boundary";
	turnIndex: number;
	toolResults: number;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface ToolNamespaceManifest {
	name: string;
	description?: string;
	instructions?: string;
	aliases?: string[];
}

interface ToolAnnotationsManifest {
	readOnlyHint?: boolean;
	destructiveHint?: boolean;
	idempotentHint?: boolean;
	openWorldHint?: boolean;
}

/** A JSON-safe snapshot of one exact manager capability granted to a worker. */
interface DelegatedToolManifest {
	name: string;
	label: string;
	description: string;
	parameters: { [key: string]: JsonValue };
	outputSchema?: JsonValue;
	namespace?: ToolNamespaceManifest;
	annotations?: ToolAnnotationsManifest;
	promptGuidelines?: string[];
	executionMode?: "sequential" | "parallel";
	fingerprint: string;
}

/** The only model-facing fields that cross the private proxy IPC boundary. */
interface ProxyWireResult {
	content: JsonValue[];
	structuredContent?: JsonValue;
	isError?: boolean;
	terminate?: boolean;
}

interface ExecutorLease {
	rootToolCallId: string;
	ctx: ExtensionToolContext;
	signal: AbortSignal | undefined;
}

interface ProxyRequestState {
	lease: ExecutorLease;
	controller: AbortController;
	removeParentAbort: (() => void) | undefined;
}

type EventUsage = Partial<UsageTotals> & { cost?: Partial<UsageTotals["cost"]> };

const TEST_MODE = process.env.PI_TASK_DISPATCHER_TEST_MODE === "1";
const CONFIG_PATH = TEST_MODE && process.env.PI_TASK_DISPATCHER_CONFIG_PATH
	? process.env.PI_TASK_DISPATCHER_CONFIG_PATH
	: path.join(getAgentDir(), "task-dispatcher.json");
const WORKER_ENV = "PI_TASK_DISPATCHER_WORKER";
const WIDGET_ID = "pi-task-dispatcher-worker";
const MODEL_TEXT_LIMIT = 5_000;
const PRESENTATION_PREVIEW_ROWS = 5;
const PRESENTATION_UPDATE_THROTTLE_MS = 100;
const STDERR_LIMIT = 16_000;
const PROXY_PAYLOAD_LIMIT_BYTES = 16 * 1024 * 1024;
const PROXY_MANIFEST_LIMIT_BYTES = 8 * 1024 * 1024;
const PROXY_MAX_IN_FLIGHT_REQUESTS = 32;
const PROXY_MAX_REQUESTS_PER_JOB = 4_096;
const REVOKED_EXECUTOR_ROOT_LIMIT = 4_096;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const ROLES: Role[] = ["mechanic", "assistant", "engineer", "designer"];

const DEFAULT_CONFIG: DispatcherConfig = {
	mechanic: {},
	assistant: {},
	engineer: {},
	designer: {},
	policy: {
		absoluteMaxTurns: 96,
		absoluteMaxSeconds: 7_200,
		pausedLeaseSeconds: 1_800,
		noProgressSeconds: 600,
	},
};

const ROLE_PROMPTS: Record<Role, string> = {
	mechanic: `You are the mechanical worker in a supervised delegated Pi task.
Complete only the supplied bounded objective with the available tools. Work in cohesive tool batches. After each tool batch the dispatcher pauses you externally so the manager can inspect state. On continuation, use the existing tool results and continue without repeating completed work. Finish with a concise report containing status, files changed, checks, and unresolved items.`,
	assistant: `You are the assistant worker in a supervised delegated Pi task.
Complete only the supplied bounded, low-complexity objective. Apply limited interpretation or synthesis, but do not assume manager responsibilities, expand scope, or make architectural decisions. Work in cohesive tool batches. After each tool batch the dispatcher pauses you externally so the manager can inspect state. On continuation, use existing results without repeating completed work. Finish with a concise report containing outcome, evidence, changes, checks, and unresolved items.`,
	engineer: `You are the engineering worker in a supervised delegated Pi task.
Own only the supplied subtask while the caller retains integration responsibility. Investigate, implement, and verify in cohesive tool batches. After each tool batch the dispatcher pauses you externally so the manager can inspect state. On continuation, use the existing tool results and continue without repeating completed work. Finish with a concise report containing outcome, files changed, checks, decisions, and unresolved items.`,
	designer: `You are the media designer worker in a supervised delegated Pi task.
Own only the supplied image, video, audio, or media-asset objective while the caller retains integration responsibility. When available, use read for visual inputs, codemode image models for image generation or editing, and explicitly available command-line programs such as ffmpeg for media processing. Verify required executables before depending on them. Treat codemode-generated images as temporary until you copy the selected result to the requested workspace destination and verify it. Preserve source assets unless the task explicitly requires replacement. Work in cohesive tool batches; the dispatcher pauses after each batch. Finish with a concise report containing outputs, source files affected, tools used, checks, and unresolved items.`,
};

const ROLE_DESCRIPTIONS: Record<Role, string> = {
	mechanic: "Start a supervised mechanical delegation for prescribed execution with a known method and result.",
	assistant: "Start a supervised assistant delegation for a subtask you would otherwise perform directly, when no other worker role applies.",
	engineer: "Start a supervised engineering delegation for uncertain, cross-component, or implementation-intensive work.",
	designer: "Start a supervised media-design delegation for image generation or editing and command-line image, video, or audio processing.",
};

const ROLE_TOOL_NAMES: Record<Role, string> = {
	mechanic: "delegate_mechanical",
	assistant: "delegate_assistant",
	engineer: "delegate_engineering",
	designer: "delegate_designer",
};

const ROLE_LABELS: Record<Role, string> = {
	mechanic: "↗ mechanic",
	assistant: "↗ assistant",
	engineer: "↗ engineer",
	designer: "↗ designer",
};

const WorkloadSchema = Type.Object({
	investigationUnits: Type.Integer({ minimum: 0, maximum: 32 }),
	changeUnits: Type.Integer({ minimum: 0, maximum: 32 }),
	verificationUnits: Type.Integer({ minimum: 0, maximum: 16 }),
	expectedLongRunningSeconds: Type.Integer({ minimum: 0, maximum: 3_600 }),
});

/** Tell managers when a codemode delegation grant is warranted without granting it automatically. */
const CODEMODE_SELECTION_GUIDANCE = "When codemode is active and delegated work materially benefits from JavaScript orchestration, batched/parallel/filtering of selected tools, or classifier/image models, include codemode in the delegated allowlist rather than reserving it for the manager; also include each direct tool the codemode script must call; otherwise omit it.";

const DelegateParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: 12_000 }),
	tools: Type.Array(Type.String({ minLength: 1 }), { maxItems: 32, description: CODEMODE_SELECTION_GUIDANCE }),
	workload: WorkloadSchema,
});

const ControlParams = Type.Object({
	jobId: Type.String({ minLength: 1 }),
	action: Type.Union([
		Type.Literal("continue"),
		Type.Literal("revise"),
		Type.Literal("recalculate"),
		Type.Literal("compact"),
		Type.Literal("take_over"),
		Type.Literal("checkpoint"),
		Type.Literal("cancel"),
	]),
	instructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8_000 })),
	workload: Type.Optional(WorkloadSchema),
	actionBatches: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
});

const StatusParams = Type.Object({
	jobId: Type.Optional(Type.String({ minLength: 1 })),
});

/** Return only an exact nonrecursive tool list for Pi's pre-execution reachability check. */
function exactDelegatedReachability(input: unknown): readonly string[] {
	if (!isRecord(input) || !Array.isArray(input.tools) || input.tools.length > 32) return [];
	const forbidden = new Set([...Object.values(ROLE_TOOL_NAMES), "delegate_control", "delegate_status"]);
	const grant: string[] = [];
	for (const name of input.tools) {
		if (typeof name !== "string" || name.length === 0 || name.trim() !== name || forbidden.has(name) || grant.includes(name)) return [];
		grant.push(name);
	}
	return grant;
}

/** Identify plain objects before reading configuration and RPC data. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Copy the JSON-visible surface of a schema or result without silently dropping unsupported values.
 * TypeBox's own symbol markers are deliberately excluded: they are not model-facing JSON Schema.
 */
function cloneJsonValue(value: unknown, label: string): JsonValue {
	const seen = new WeakSet<object>();
	const visit = (candidate: unknown, location: string): JsonValue => {
		if (candidate === null || typeof candidate === "string" || typeof candidate === "boolean") return candidate;
		if (typeof candidate === "number") {
			if (!Number.isFinite(candidate) || Object.is(candidate, -0)) throw new Error(`${label} is not JSON-serializable at ${location}`);
			return candidate;
		}
		if (Array.isArray(candidate)) {
			if (seen.has(candidate)) throw new Error(`${label} contains a cycle at ${location}`);
			seen.add(candidate);
			const result = candidate.map((item, index) => visit(item, `${location}[${index}]`));
			seen.delete(candidate);
			return result;
		}
		if (!isRecord(candidate)) throw new Error(`${label} is not JSON-serializable at ${location}`);
		if (seen.has(candidate)) throw new Error(`${label} contains a cycle at ${location}`);
		const prototype = Object.getPrototypeOf(candidate);
		if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} has an unsupported object at ${location}`);
		const unsupportedSymbols = Object.getOwnPropertySymbols(candidate)
			.filter((symbol) => Object.prototype.propertyIsEnumerable.call(candidate, symbol))
			.filter((symbol) => !String(symbol).startsWith("Symbol(TypeBox."));
		if (unsupportedSymbols.length > 0) throw new Error(`${label} has an unsupported symbol at ${location}`);
		seen.add(candidate);
		const result: { [key: string]: JsonValue } = {};
		for (const key of Object.keys(candidate)) {
			const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
			if (!descriptor || !("value" in descriptor)) throw new Error(`${label} has an accessor at ${location}.${key}`);
			result[key] = visit(descriptor.value, `${location}.${key}`);
		}
		seen.delete(candidate);
		return result;
	};
	return visit(value, "$" );
}

/** Produce a deterministic compatibility fingerprint without changing the model-facing field order. */
function stableJson(value: JsonValue): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

/** Reject an otherwise JSON-safe proxy value before it can create an unbounded IPC message. */
function assertJsonByteLimit(value: JsonValue, label: string, maximum: number): void {
	const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
	if (bytes > maximum) throw new Error(`${label} exceeds the ${maximum}-byte proxy limit`);
}

/** Return a failure result that is safe to send over the proxy channel. */
function proxyErrorResult(message: string): ProxyWireResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/** Strip parent-only details and usage before a nested manager result reaches the child session. */
function serializeProxyResult(value: unknown, forceError = false): ProxyWireResult {
	if (!isRecord(value) || !Array.isArray(value.content)) return proxyErrorResult("Manager tool returned an invalid result.");
	try {
		const result: ProxyWireResult = { content: cloneJsonValue(value.content, "manager tool content") as JsonValue[] };
		if (Object.prototype.hasOwnProperty.call(value, "structuredContent")) {
			result.structuredContent = cloneJsonValue(value.structuredContent, "manager tool structured content");
		}
		if (value.isError === true || forceError) result.isError = true;
		if (value.terminate === true) result.terminate = true;
		assertJsonByteLimit(result as unknown as JsonValue, "manager tool result", PROXY_PAYLOAD_LIMIT_BYTES);
		return result;
	} catch (error) {
		return proxyErrorResult(`Manager tool result could not be serialized: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Create a fresh usage accumulator for one worker job. */
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

/** Add one independently reported usage record without changing its provenance. */
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

/** Return only usage not already attributed by an earlier parent tool result. */
function usageDifference(current: UsageTotals, previous: UsageTotals): UsageTotals {
	const result = emptyUsage();
	result.input = Math.max(0, current.input - previous.input);
	result.output = Math.max(0, current.output - previous.output);
	result.cacheRead = Math.max(0, current.cacheRead - previous.cacheRead);
	result.cacheWrite = Math.max(0, current.cacheWrite - previous.cacheWrite);
	result.totalTokens = Math.max(0, current.totalTokens - previous.totalTokens);
	if (current.cacheWrite1h !== undefined) result.cacheWrite1h = Math.max(0, current.cacheWrite1h - (previous.cacheWrite1h ?? 0));
	if (current.reasoning !== undefined) result.reasoning = Math.max(0, current.reasoning - (previous.reasoning ?? 0));
	result.cost.input = Math.max(0, current.cost.input - previous.cost.input);
	result.cost.output = Math.max(0, current.cost.output - previous.cost.output);
	result.cost.cacheRead = Math.max(0, current.cost.cacheRead - previous.cost.cacheRead);
	result.cost.cacheWrite = Math.max(0, current.cost.cacheWrite - previous.cost.cacheWrite);
	result.cost.total = Math.max(0, current.cost.total - previous.cost.total);
	return result;
}

/** Preserve both conclusions and setup when shortening model-facing worker text. */
function headTail(text: string, limit = MODEL_TEXT_LIMIT): { text: string; truncated: boolean } {
	if (text.length <= limit) return { text, truncated: false };
	const markerBudget = 100;
	const available = Math.max(2, limit - markerBudget);
	const headLength = Math.ceil(available * 0.4);
	const tailLength = available - headLength;
	const omitted = text.length - headLength - tailLength;
	return {
		text: `${text.slice(0, headLength)}\n\n[… ${omitted} characters omitted; complete text retained in tool details …]\n\n${text.slice(-tailLength)}`,
		truncated: true,
	};
}

/** Remove terminal controls from child-provided text before it enters a structured snapshot or renderer. */
function sanitizePresentationText(value: unknown): string {
	if (typeof value !== "string") return "";
	return stripTerminalSequences(value)
		.replace(/\r\n?/g, "\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Keep one-line task and activity clues compact without introducing multiline omission markers. */
function compactLine(value: unknown, limit = 180): string {
	const normalized = sanitizePresentationText(value).replaceAll(/\s+/g, " ").trim();
	if (!normalized) return "Preparing delegation…";
	return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(1, limit - 1))}…`;
}

/** Keep the latest diagnostics because process failures are normally reported at the end. */
function appendTail(current: string, addition: string, limit: number): string {
	const combined = current + addition;
	return combined.length <= limit ? combined : `[earlier stderr omitted]\n${combined.slice(-limit)}`;
}

/** Validate workload semantics independently from the TypeBox transport schema. */
function validateWorkload(workload: Workload): void {
	if (workload.investigationUnits + workload.changeUnits + workload.verificationUnits <= 0) {
		throw new Error("workload must include at least one investigation, change, or verification unit");
	}
}

/** Convert semantic work estimates and model limits into enforceable job ceilings. */
function calculateBudget(
	role: Role,
	workload: Workload,
	contextWindow: number,
	maxOutputTokens: number,
	policy: DispatcherPolicy,
): CalculatedBudget {
	validateWorkload(workload);
	const plannedTurns =
		2 +
		Math.ceil(workload.investigationUnits * 1.25) +
		Math.ceil(workload.changeUnits * 1.5) +
		workload.verificationUnits;
	const roleFactor = role === "engineer" || role === "designer" ? 1.25 : 1;
	const contextScale = Math.max(0.75, Math.min(1.5, contextWindow / 400_000));
	// Reserve two turns for synthesis or recovery after the planned tool-producing work.
	const turns = Math.min(policy.absoluteMaxTurns, Math.max(6, Math.ceil(plannedTurns * roleFactor * contextScale) + 2));
	const secondsPerTurn = role === "engineer" || role === "designer" ? 50 : 30;
	const seconds = Math.min(
		policy.absoluteMaxSeconds,
		Math.max(120, 30 + turns * secondsPerTurn + workload.expectedLongRunningSeconds),
	);
	return { workload: { ...workload }, turns, seconds, contextWindow, maxOutputTokens };
}

/** Merge optional user configuration while keeping ordinary task budgets formula-owned. */
function loadConfig(): DispatcherConfig {
	const result: DispatcherConfig = {
		mechanic: { ...DEFAULT_CONFIG.mechanic },
		assistant: { ...DEFAULT_CONFIG.assistant },
		engineer: { ...DEFAULT_CONFIG.engineer },
		designer: { ...DEFAULT_CONFIG.designer },
		policy: { ...DEFAULT_CONFIG.policy },
	};
	if (!fs.existsSync(CONFIG_PATH)) return result;
	const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as unknown;
	if (!isRecord(parsed)) throw new Error(`${CONFIG_PATH} must contain an object`);
	for (const role of ROLES) {
		const value = parsed[role];
		if (value === undefined) continue;
		if (!isRecord(value)) throw new Error(`"${role}" must be an object`);
		if (value.model !== undefined) {
			if (typeof value.model !== "string" || !value.model.includes("/")) throw new Error(`"${role}.model" must be provider/model`);
			result[role].model = value.model;
		}
		if (value.thinking !== undefined) {
			if (typeof value.thinking !== "string" || !THINKING_LEVELS.has(value.thinking as ThinkingLevel)) {
				throw new Error(`"${role}.thinking" is invalid`);
			}
			result[role].thinking = value.thinking as ThinkingLevel;
		}
	}
	if (parsed.policy !== undefined) {
		if (!isRecord(parsed.policy)) throw new Error('"policy" must be an object');
		for (const field of ["absoluteMaxTurns", "absoluteMaxSeconds", "pausedLeaseSeconds", "noProgressSeconds"] as const) {
			const value = parsed.policy[field];
			if (value === undefined) continue;
			if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`"policy.${field}" must be a positive integer`);
			result.policy[field] = value as number;
		}
	}
	return result;
}

/** Resolve the direct current Pi CLI script required for Node IPC supervision. */
function getDirectPiInvocation(args: string[]): { command: string; args: string[] } {
	if (TEST_MODE && process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE) {
		return { command: process.execPath, args: [process.env.PI_TASK_DISPATCHER_CLI_OVERRIDE, ...args] };
	}
	const currentScript = process.argv[1];
	if (!currentScript || currentScript.startsWith("/$bunfs/root/") || !fs.existsSync(currentScript)) {
		throw new Error("Supervised delegation requires a directly addressable current Pi CLI script.");
	}
	if (!/^(node)(\.exe)?$/i.test(path.basename(process.execPath))) {
		throw new Error("Supervised delegation requires Pi to run under Node.js so the private IPC gate is enforceable.");
	}
	return { command: process.execPath, args: [currentScript, ...args] };
}

/** Render a bounded activity label without embedding bulky command content. */
function formatActivity(name: string, args: unknown): string {
	if (name === "bash" && isRecord(args) && typeof args.command === "string") {
		return `$ ${headTail(sanitizePresentationText(args.command), 140).text.replaceAll("\n", " ")}`;
	}
	if (isRecord(args) && typeof args.path === "string") return `${name} ${sanitizePresentationText(args.path)}`;
	return sanitizePresentationText(name) || "tool";
}

/** Extract a text-only assistant report from one finalized RPC message. */
function assistantText(event: ParsedEvent): string {
	return (event.message?.content ?? [])
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => sanitizePresentationText(part.text))
		.filter(Boolean)
		.join("\n")
		.trim();
}

/** Extract text and image placeholders without retaining image base64 in state or rendered output. */
function presentationResult(result: RpcToolResult | undefined): { text: string; mediaOutputs: WorkerMediaOutput[] } {
	const text: string[] = [];
	const mediaOutputs: WorkerMediaOutput[] = [];
	// Inspect content block types without persisting image payloads or redundant partial snapshots.
	for (const part of result?.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") {
			const value = sanitizePresentationText(part.text);
			if (value) text.push(value);
			continue;
		}
		if (part.type !== "image") continue;
		const mimeType = sanitizePresentationText(part.mimeType) || "image";
		const bytes = typeof part.data === "string" ? Buffer.from(part.data, "base64").length : 0;
		if (typeof part.data === "string") mediaOutputs.push({ mimeType, bytes });
		text.push(bytes > 0 ? `[image ${mimeType} · ${bytes} bytes]` : `[image ${mimeType}]`);
	}
	return { text: text.join("\n"), mediaOutputs };
}

/** Build the native codemode extension in only mode so selected direct tools stay script-callable but model-hidden. */
function codemodeOnlySource(): string {
	return `/** Load Pi's public codemode factory without loading discovered extensions. */
import { createCodemodeExtension, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
const codemodeOnly = createCodemodeExtension({ mode: "only" });
export default function codemodeOnlyExtension(pi: ExtensionAPI): void {
	codemodeOnly(pi);
}
`;
}

/** Build a child-local proxy for exactly the manager tools granted to this job. */
function proxyExtensionSource(manifests: readonly DelegatedToolManifest[], nonce: string): string {
	const tools = manifests
		.filter((manifest) => manifest.name !== "codemode")
		.map(({ fingerprint: _fingerprint, ...manifest }) => manifest);
	const configuration = JSON.stringify({ nonce, tools });
	return `/** Route selected worker tool calls through the parent manager's current ExtensionToolContext. */
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type WireResult = { content: unknown[]; structuredContent?: unknown; isError?: boolean; terminate?: boolean };
type ProxyTool = {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	outputSchema?: unknown;
	namespace?: { name: string; description?: string; instructions?: string; aliases?: string[] };
	annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
	promptGuidelines?: string[];
	executionMode?: "sequential" | "parallel";
};
const configuration = ${configuration} as { nonce: string; tools: ProxyTool[] };
const payloadLimitBytes = ${PROXY_PAYLOAD_LIMIT_BYTES};
const maximumInFlightRequests = ${PROXY_MAX_IN_FLIGHT_REQUESTS};
const textEncoder = new TextEncoder();
const pending = new Map<string, { resolve: (result: any) => void; onUpdate: ((result: any) => void) | undefined; signal: AbortSignal | undefined; onAbort: (() => void) | undefined }>();
let requestSequence = 0;

function failure(message: string): any {
	return { content: [{ type: "text", text: message }], details: undefined, isError: true };
}

function resultFromWire(value: unknown): any {
	if (!value || typeof value !== "object" || Array.isArray(value)) return failure("Dispatcher proxy received an invalid manager result.");
	try {
		const encoded = JSON.stringify(value);
		if (encoded === undefined || textEncoder.encode(encoded).byteLength > payloadLimitBytes) return failure("Dispatcher proxy received an oversized manager result.");
	} catch {
		return failure("Dispatcher proxy received a non-serializable manager result.");
	}
	const wire = value as WireResult;
	if (!Array.isArray(wire.content)) return failure("Dispatcher proxy received a manager result without content.");
	const result: any = { content: wire.content, details: undefined };
	if (Object.prototype.hasOwnProperty.call(wire, "structuredContent")) result.structuredContent = wire.structuredContent;
	if (wire.isError === true) result.isError = true;
	if (wire.terminate === true) result.terminate = true;
	return result;
}

function send(message: Record<string, unknown>): void {
	if (typeof process.send !== "function") throw new Error("Task dispatcher proxy IPC is unavailable.");
	process.send(message);
}

function finish(requestId: string, result: any): void {
	const request = pending.get(requestId);
	if (!request) return;
	pending.delete(requestId);
	if (request.signal && request.onAbort) request.signal.removeEventListener("abort", request.onAbort);
	request.resolve(result);
}

process.on("message", (incoming: unknown) => {
	if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return;
	const message = incoming as Record<string, unknown>;
	if (message.nonce !== configuration.nonce || typeof message.requestId !== "string") return;
	if (message.type === "task_dispatcher_proxy_update") {
		const request = pending.get(message.requestId);
		if (!request) return;
		try { request.onUpdate?.(resultFromWire(message.result)); } catch { /* A renderer must not affect proxy control flow. */ }
		return;
	}
	if (message.type === "task_dispatcher_proxy_result") finish(message.requestId, resultFromWire(message.result));
});
process.on("disconnect", () => {
	for (const requestId of [...pending.keys()]) finish(requestId, failure("Task dispatcher parent IPC disconnected."));
});

export default function taskDispatcherProxy(pi: ExtensionAPI): void {
	for (const manifest of configuration.tools) {
		pi.registerTool({
			name: manifest.name,
			label: manifest.label,
			description: manifest.description,
			parameters: Type.Unsafe(manifest.parameters) as any,
			...(manifest.outputSchema === undefined ? {} : { outputSchema: Type.Unsafe(manifest.outputSchema) as any }),
			...(manifest.namespace === undefined ? {} : { namespace: manifest.namespace }),
			...(manifest.annotations === undefined ? {} : { annotations: manifest.annotations }),
			...(manifest.promptGuidelines === undefined ? {} : { promptGuidelines: manifest.promptGuidelines }),
			...(manifest.executionMode === undefined ? {} : { executionMode: manifest.executionMode }),
			exposure: "direct",
			defaultActive: true,
			async execute(_toolCallId, args, signal, onUpdate) {
				if (signal?.aborted) return failure("Worker proxy call was already aborted.");
				if (pending.size >= maximumInFlightRequests) return failure("Worker proxy has too many in-flight manager requests.");
				let serializedArgs: unknown;
				try {
					const encoded = JSON.stringify(args);
					if (encoded === undefined) throw new Error("arguments are not JSON-serializable");
					if (textEncoder.encode(encoded).byteLength > payloadLimitBytes) throw new Error("arguments exceed the " + payloadLimitBytes + "-byte proxy limit");
					serializedArgs = JSON.parse(encoded);
				} catch (error) {
					return failure("Worker proxy arguments could not be serialized: " + (error instanceof Error ? error.message : String(error)));
				}
				const requestId = "proxy-" + (++requestSequence);
				return await new Promise<any>((resolve) => {
					const onAbort = () => {
						try { send({ type: "task_dispatcher_proxy_cancel", nonce: configuration.nonce, requestId }); } catch { /* Parent teardown wins. */ }
						finish(requestId, failure("Worker proxy call was aborted."));
					};
					pending.set(requestId, { resolve, onUpdate, signal, onAbort });
					signal?.addEventListener("abort", onAbort, { once: true });
					try {
						send({ type: "task_dispatcher_proxy_request", nonce: configuration.nonce, requestId, toolName: manifest.name, args: serializedArgs });
					} catch (error) {
						finish(requestId, failure("Task dispatcher proxy request failed: " + (error instanceof Error ? error.message : String(error))));
					}
				});
			},
		});
	}
}
`;
}

/** Build the worker-only gate extension that stops the agent loop after persisted tool results. */
function gateSource(): string {
	return `/** Pause this worker after each persisted tool batch so only the parent dispatcher can resume it. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): void {
	pi.on("turn_end", async (event, ctx) => {
		if (event.toolResults.length === 0) return;
		if (typeof process.send !== "function") {
			ctx.abort();
			throw new Error("Task dispatcher IPC is unavailable.");
		}
		process.send({ type: "task_dispatcher_boundary", turnIndex: event.turnIndex, toolResults: event.toolResults.length });
		ctx.abort();
	});
}
`;
}

/** Return whether a job status can no longer execute or resume work. */
function isTerminal(status: JobStatus): boolean {
	return ["completed", "checkpointed", "taken_over", "cancelled", "hard_stopped", "failed"].includes(status);
}

let nextJobIndex = 1;
const revokedExecutorRoots = new Set<string>();
let revokedExecutorGuardSaturated = false;

/** Bound stale-lease tracking and fail every otherwise-unattributed nested call after saturation. */
function revokeExecutorRoot(rootToolCallId: string): void {
	if (revokedExecutorGuardSaturated) return;
	if (revokedExecutorRoots.size >= REVOKED_EXECUTOR_ROOT_LIMIT) {
		revokedExecutorRoots.clear();
		revokedExecutorGuardSaturated = true;
		return;
	}
	revokedExecutorRoots.add(rootToolCallId);
}

/** Reject a nested manager call attributable to a revoked lease. */
function revokedExecutorDecision(parentToolCallId: string | undefined, toolName: string): { block: boolean; reason: string } | undefined {
	if (!parentToolCallId) return undefined;
	if (revokedExecutorGuardSaturated) {
		return { block: true, reason: `Nested manager tool ${toolName} was rejected because stale-lease tracking reached its fail-closed limit.` };
	}
	for (const rootToolCallId of revokedExecutorRoots) {
		if (parentToolCallId === rootToolCallId || parentToolCallId.startsWith(`${rootToolCallId}/`)) {
			return { block: true, reason: `Nested manager tool ${toolName} was rejected because its executor lease is no longer active.` };
		}
	}
	return undefined;
}

/** Supervise one reusable in-memory Pi worker and expose only boundary-sized state. */
class WorkerJob {
	readonly id: string;
	readonly role: Role;
	readonly task: string;
	readonly tools: string[];
	readonly manifests: readonly DelegatedToolManifest[];
	readonly model: string;
	readonly thinking: ThinkingLevel;
	readonly cwd: string;
	readonly policy: DispatcherPolicy;
	readonly budget: CalculatedBudget;
	readonly startedAt = Date.now();
	readonly usage = emptyUsage();
	readonly actions: WorkerAction[] = [];
	readonly context: ContextMetrics;
	private readonly pi: ExtensionAPI;
	private readonly manifestByName: ReadonlyMap<string, DelegatedToolManifest>;
	private readonly callableIdentityByName: ReadonlyMap<string, unknown>;
	private readonly proxyNonce = randomBytes(24).toString("hex");

	status: JobStatus = "starting";
	sequence = 0;
	turns = 0;
	phase = "startup";
	recommendation = "continue";
	workerText = "";
	diagnostic: string | undefined;

	private child: ChildProcess | undefined;
	private temporaryDirectory: string | undefined;
	private temporaryRemoval: Promise<void> | undefined;
	private stdoutBuffer = "";
	private stderr = "";
	private requestSequence = 0;
	private actionSequence = 0;
	private completionSequence = 0;
	private assistantIdSequence = 0;
	private readonly presentationEntries: WorkerPresentationEntry[] = [];
	private readonly presentationById = new Map<string, WorkerPresentationEntry>();
	private readonly assistantTextBlocks = new Map<number, string>();
	private activeAssistantPresentation: WorkerPresentationEntry | undefined;
	private activeActions = new Map<string, WorkerAction>();
	private pendingRequests = new Map<string, { resolve: (event: ParsedEvent) => void; reject: (error: Error) => void }>();
	private settleWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
	private boundaryWaiter: { resolve: () => void; reject: (error: Error) => void } | undefined;
	private boundaryObserved = false;
	private lastStopReason: string | undefined;
	private lastProgressAt = Date.now();
	private activeElapsedMs = 0;
	private activeStartedAt: number | undefined;
	private progressCallback: ((snapshot: WorkerSnapshot) => void) | undefined;
	private progressUpdate: ReturnType<typeof setTimeout> | undefined;
	private pausedLease: ReturnType<typeof setTimeout> | undefined;
	private closePromise: Promise<void> | undefined;
	private executorLease: ExecutorLease | undefined;
	private readonly proxyRequests = new Map<string, ProxyRequestState>();
	private readonly seenProxyRequests = new Set<string>();

	constructor(
		role: Role,
		task: string,
		manifests: DelegatedToolManifest[],
		config: ResolvedWorkerRoleConfig,
		cwd: string,
		policy: DispatcherPolicy,
		budget: CalculatedBudget,
		pi: ExtensionAPI,
		callableTools: ExtensionToolContext["tools"],
	) {
		this.id = `${role}-${nextJobIndex++}`;
		this.role = role;
		this.task = task;
		this.manifests = manifests.map((manifest) => structuredClone(manifest));
		this.tools = this.manifests.map((manifest) => manifest.name);
		this.manifestByName = new Map(this.manifests.map((manifest) => [manifest.name, manifest]));
		this.callableIdentityByName = new Map(callableTools.map((tool) => [tool.name, tool]));
		this.model = config.model;
		this.thinking = config.thinking;
		this.cwd = cwd;
		this.policy = policy;
		this.budget = budget;
		this.pi = pi;
		this.context = {
			contextWindow: budget.contextWindow,
			peakPercent: 0,
			compactionAttempts: 0,
			compactions: 0,
			compactionSkips: 0,
			compactionFailures: 0,
		};
	}

	/** Start the isolated child, initialize compaction policy, and execute the first supervised stage. */
	async start(rootToolCallId: string, signal: AbortSignal | undefined, onProgress: (snapshot: WorkerSnapshot) => void, ctx: ExtensionToolContext): Promise<WorkerSnapshot> {
		this.temporaryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-task-dispatcher-"));
		const rolePromptPath = path.join(this.temporaryDirectory, `${this.role}.md`);
		const proxyPath = path.join(this.temporaryDirectory, "tool-proxies.ts");
		const gatePath = path.join(this.temporaryDirectory, "supervision-gate.ts");
		const codemodeOnlyPath = path.join(this.temporaryDirectory, "codemode-only.ts");
		await fs.promises.writeFile(rolePromptPath, ROLE_PROMPTS[this.role], { encoding: "utf8", mode: 0o600 });
		await fs.promises.writeFile(proxyPath, proxyExtensionSource(this.manifests, this.proxyNonce), { encoding: "utf8", mode: 0o600 });
		await fs.promises.writeFile(gatePath, gateSource(), { encoding: "utf8", mode: 0o600 });
		if (this.tools.includes("codemode")) {
			await fs.promises.writeFile(codemodeOnlyPath, codemodeOnlySource(), { encoding: "utf8", mode: 0o600 });
		}

		const args = [
			"--mode", "rpc",
			"--no-session",
			"--no-extensions",
			"--model", this.model,
			"--thinking", this.thinking,
			...(this.tools.length > 0 ? ["--tools", this.tools.join(",")] : ["--no-tools"]),
			"--append-system-prompt", rolePromptPath,
			"--extension", proxyPath,
			...(this.tools.includes("codemode") ? ["--extension", codemodeOnlyPath] : []),
			"--extension", gatePath,
		];
		const invocation = getDirectPiInvocation(args);
		this.child = spawn(invocation.command, invocation.args, {
			cwd: this.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe", "ipc"],
			env: { ...process.env, [WORKER_ENV]: this.role },
		});
		this.attachProcessHandlers();
		this.activeStartedAt = Date.now();
		try {
			await this.request("set_auto_compaction", { type: "set_auto_compaction", enabled: true }, this.operationTimeout(30_000));
		} finally {
			this.commitActiveElapsed();
		}
		return await this.runStages(`Delegated ${this.role} task:\n${this.task}`, 1, rootToolCallId, signal, onProgress, ctx);
	}

	/** Continue or revise work for a bounded number of action batches. */
	async continue(
		instructions: string | undefined,
		actionBatches: number,
		rootToolCallId: string,
		signal: AbortSignal | undefined,
		onProgress: (snapshot: WorkerSnapshot) => void,
		ctx: ExtensionToolContext,
	): Promise<WorkerSnapshot> {
		if (this.status !== "paused") throw new Error(`Job ${this.id} is ${this.status}, not paused.`);
		try {
			this.revalidateManifest(ctx);
		} catch (error) {
			const reason = `Delegated tool manifest revalidation failed: ${error instanceof Error ? error.message : String(error)}`;
			await this.stop("hard_stopped", reason);
			throw new Error(reason);
		}
		this.clearPausedLease();
		const message = instructions
			? `The manager revised the delegated task with these controlling instructions:\n${instructions}\nContinue from completed work without repeating it.`
			: "Continue the delegated task from the completed tool results. Do not repeat completed work.";
		try {
			return await this.runStages(message, actionBatches, rootToolCallId, signal, onProgress, ctx);
		} catch (error) {
			if (this.status === "paused") this.schedulePausedLease();
			throw error;
		}
	}

	/** Recalculate formula-owned ceilings from a revised semantic workload. */
	recalculate(workload: Workload): WorkerSnapshot {
		if (this.status !== "paused") throw new Error(`Job ${this.id} is ${this.status}, not paused.`);
		const remaining = calculateBudget(
			this.role,
			workload,
			this.budget.contextWindow,
			this.budget.maxOutputTokens,
			this.policy,
		);
		const recalculated: CalculatedBudget = {
			...remaining,
			turns: Math.min(this.policy.absoluteMaxTurns, this.turns + remaining.turns),
			seconds: Math.min(this.policy.absoluteMaxSeconds, Math.ceil(this.currentActiveElapsedMs() / 1_000) + remaining.seconds),
		};
		Object.assign(this.budget, recalculated);
		this.phase = "budget recalculated";
		this.recommendation = "continue";
		return this.snapshot();
	}

	/** Compact the idle worker context and refresh authoritative RPC statistics. */
	async compact(): Promise<WorkerSnapshot> {
		if (this.status !== "paused") throw new Error(`Job ${this.id} is ${this.status}, not paused.`);
		this.clearPausedLease();
		this.status = "compacting";
		this.phase = "worker context compaction";
		this.activeStartedAt = Date.now();
		let response: ParsedEvent;
		try {
			response = await this.request("compact", { type: "compact" }, this.operationTimeout(300_000));
		} finally {
			this.commitActiveElapsed();
			if (this.status === "compacting") this.status = "paused";
			this.schedulePausedLease();
		}
		if (!response.success) {
			this.phase = "compaction not performed";
			this.diagnostic = response.error || "Worker compaction was unavailable.";
			this.recommendation = "continue without compaction, checkpoint, or take over";
			await this.refreshStats();
			return this.snapshot();
		}
		this.phase = "compaction complete";
		this.diagnostic = undefined;
		this.recommendation = "continue";
		await this.refreshStats();
		return this.snapshot();
	}

	/** End the job from parent-observed state without asking the worker to cooperate. */
	async stop(status: Extract<JobStatus, "checkpointed" | "taken_over" | "cancelled" | "hard_stopped">, reason: string): Promise<WorkerSnapshot> {
		this.clearPausedLease();
		this.clearExecutorLease();
		this.status = status;
		this.phase = reason;
		this.recommendation = status === "taken_over" ? "manager owns remaining work" : "closed";
		const snapshot = this.snapshot();
		await this.dispose();
		return snapshot;
	}

	/** Return a stable state projection without exposing process handles or raw RPC records. */
	snapshot(): WorkerSnapshot {
		const display = headTail(this.workerText);
		const presentationText = this.presentationText();
		const completed = this.actions.filter((action) => action.status === "completed").length;
		const failed = this.actions.filter((action) => action.status === "failed").length;
		const currentAction = [...this.actions].reverse().find((action) => action.status === "running");
		// Present completed actions in actual completion order while retaining start order in the ledger.
		const recentActions = this.actions
			.filter((action) => action.status !== "running")
			.sort((left, right) => (left.completionSequence ?? 0) - (right.completionSequence ?? 0))
			.slice(-8)
			.map((action) => ({ ...action, mediaOutputs: action.mediaOutputs?.map((output) => ({ ...output })) }));
		return {
			jobId: this.id,
			role: this.role,
			status: this.status,
			model: this.model,
			thinking: this.thinking,
			sequence: this.sequence,
			phase: this.phase,
			recommendation: this.recommendation,
			taskDisplay: compactLine(this.task),
			currentActivity: currentAction?.label,
			turns: this.turns,
			durationMs: this.currentActiveElapsedMs(),
			budget: { ...this.budget, workload: { ...this.budget.workload } },
			context: { ...this.context },
			actionCounts: {
				total: this.actions.length,
				completed,
				failed,
				mutations: this.actions.filter((action) => action.mutating).length,
			},
			recentActions,
			actionLedger: this.actions.map((action) => ({ ...action, mediaOutputs: action.mediaOutputs?.map((output) => ({ ...output })) })),
			workerText: this.workerText,
			presentationText,
			workerTextDisplay: display.text,
			workerTextTruncated: display.truncated,
			diagnostic: this.diagnostic,
			tools: [...this.tools],
			usage: structuredClone(this.usage),
		};
	}

	/** Release process and temporary resources idempotently. */
	async dispose(): Promise<void> {
		if (this.closePromise) return await this.closePromise;
		this.clearPausedLease();
		this.clearExecutorLease();
		if (this.progressUpdate) clearTimeout(this.progressUpdate);
		this.progressUpdate = undefined;
		this.closePromise = (async () => {
			const child = this.child;
			if (child && child.exitCode === null && child.signalCode === null) {
				child.kill("SIGTERM");
				await Promise.race([
					new Promise<void>((resolve) => child.once("close", () => resolve())),
					new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
				]);
				if (child.exitCode === null && child.signalCode === null) {
					child.kill("SIGKILL");
					await Promise.race([
						new Promise<void>((resolve) => child.once("close", () => resolve())),
						new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
					]);
				}
			}
			await this.removeTemporaryDirectory();
		})();
		return await this.closePromise;
	}

	/** Attach one reducer to each child channel and preserve failures for synthetic handoff. */
	private attachProcessHandlers(): void {
		const child = this.child;
		if (!child?.stdout || !child.stderr || !child.stdin) throw new Error("Worker process pipes are unavailable.");
		const stdoutDecoder = new TextDecoder("utf-8");
		const stderrDecoder = new TextDecoder("utf-8");
		child.stdout.on("data", (chunk) => {
			this.lastProgressAt = Date.now();
			this.stdoutBuffer += stdoutDecoder.decode(chunk, { stream: true });
			const lines = this.stdoutBuffer.split("\n");
			this.stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) this.processLine(line);
		});
		child.stderr.on("data", (chunk) => {
			this.lastProgressAt = Date.now();
			this.stderr = appendTail(this.stderr, stderrDecoder.decode(chunk, { stream: true }), STDERR_LIMIT);
		});
		child.stdin.on("error", (error) => {
			this.diagnostic = error.message;
			this.failPending(error);
		});
		child.on("message", (message) => {
			this.lastProgressAt = Date.now();
			if (!isRecord(message)) return;
			if (message.type === "task_dispatcher_boundary") {
				const boundary = message as unknown as GateBoundaryMessage;
				this.boundaryObserved = true;
				this.sequence++;
				this.phase = `completed tool batch at worker turn ${boundary.turnIndex}`;
				this.boundaryWaiter?.resolve();
				return;
			}
			if (message.type === "task_dispatcher_proxy_request") {
				void this.handleProxyRequest(message);
				return;
			}
			if (message.type === "task_dispatcher_proxy_cancel") void this.handleProxyCancel(message);
		});
		child.on("error", (error) => {
			this.diagnostic = error.message;
			this.failPending(error);
		});
		child.on("close", (code) => {
			this.stdoutBuffer += stdoutDecoder.decode();
			this.stderr = appendTail(this.stderr, stderrDecoder.decode(), STDERR_LIMIT);
			if (this.stdoutBuffer.trim()) this.processLine(this.stdoutBuffer);
			const error = new Error(this.diagnostic || `Worker process exited with code ${code ?? "unknown"}.`);
			this.failPending(error);
			if (!isTerminal(this.status)) {
				this.status = "failed";
				this.diagnostic = error.message;
			}
			void this.removeTemporaryDirectory();
		});
	}

	/** Reduce one complete JSONL record into requests, activity, usage, presentation, and settlement state. */
	private processLine(line: string): void {
		if (!line.trim()) return;
		let event: ParsedEvent;
		try {
			event = JSON.parse(line) as ParsedEvent;
		} catch {
			return;
		}
		if (event.type === "response" && event.id) {
			const pending = this.pendingRequests.get(event.id);
			if (pending) {
				this.pendingRequests.delete(event.id);
				pending.resolve(event);
			}
			return;
		}
		if (event.type === "message_start" && event.message?.role === "assistant") {
			this.beginAssistantPresentation();
			this.emitProgress();
			return;
		}
		if (event.type === "message_update" && event.assistantMessageEvent) {
			this.updateAssistantPresentation(event.assistantMessageEvent);
			this.scheduleProgressUpdate();
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const text = assistantText(event);
			this.completeAssistantPresentation(text);
			if (text) this.workerText = text;
			const stopReason = event.message.stopReason;
			const gateAbort =
				(stopReason === "aborted" || stopReason === "error") &&
				event.message.errorMessage?.toLowerCase().includes("operation was aborted");
			if (!gateAbort) {
				this.turns++;
				this.lastStopReason = stopReason;
				addUsage(this.usage, event.message.usage ?? event.usage);
				if (event.message.errorMessage) this.diagnostic = sanitizePresentationText(event.message.errorMessage);
			}
			this.emitProgress();
			return;
		}
		if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
			const action: WorkerAction = {
				sequence: ++this.actionSequence,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				label: formatActivity(event.toolName, event.args),
				mutating: this.manifestByName.get(event.toolName)?.annotations?.readOnlyHint !== true,
				status: "running",
				startedAt: Date.now(),
				parentToolCallId: event.parentToolCallId,
			};
			this.actions.push(action);
			this.activeActions.set(action.toolCallId, action);
			this.ensureToolPresentation(event.toolCallId, event.toolName, event.args, event.parentToolCallId);
			this.emitProgress();
			return;
		}
		if (event.type === "tool_execution_update" && event.toolCallId && event.toolName) {
			const entry = this.ensureToolPresentation(event.toolCallId, event.toolName, event.args, event.parentToolCallId);
			entry.status = "running";
			entry.text = presentationResult(event.partialResult).text;
			this.scheduleProgressUpdate();
			return;
		}
		if (event.type === "tool_execution_end" && event.toolCallId) {
			const result = presentationResult(event.result);
			const action = this.activeActions.get(event.toolCallId);
			const entry = this.ensureToolPresentation(
				event.toolCallId,
				event.toolName ?? action?.toolName ?? "tool",
				event.args,
				event.parentToolCallId ?? action?.parentToolCallId,
			);
			entry.status = event.isError ? "failed" : "completed";
			entry.text = result.text;
			if (action) {
				action.status = event.isError ? "failed" : "completed";
				action.endedAt = Date.now();
				action.completionSequence = ++this.completionSequence;
				if (result.mediaOutputs.length > 0) {
					action.mediaOutputs = result.mediaOutputs;
					action.label += ` · ${result.mediaOutputs.length} image${result.mediaOutputs.length === 1 ? "" : "s"}`;
					entry.label = action.label;
				}
				this.activeActions.delete(event.toolCallId);
			}
			// Execution-end events carry each call's own usage before Pi merges nested usage into persistence.
			addUsage(this.usage, event.result?.usage);
			this.emitProgress();
			return;
		}
		if (event.type === "compaction_start") {
			this.context.compactionAttempts++;
			return;
		}
		if (event.type === "compaction_end") {
			if (event.errorMessage?.toLowerCase().includes("nothing to compact")) this.context.compactionSkips++;
			else if (event.aborted || event.errorMessage) this.context.compactionFailures++;
			else this.context.compactions++;
			addUsage(this.usage, event.result?.usage);
			return;
		}
		if (event.type === "agent_settled") this.settleWaiter?.resolve();
	}

	/** Start a replaceable assistant entry so streamed deltas never duplicate retained presentation text. */
	private beginAssistantPresentation(): WorkerPresentationEntry {
		if (this.activeAssistantPresentation) return this.activeAssistantPresentation;
		this.assistantTextBlocks.clear();
		const entry: WorkerPresentationEntry = {
			id: `assistant-${++this.assistantIdSequence}`,
			kind: "assistant",
			label: "assistant",
			status: "streaming",
			text: "",
		};
		this.presentationEntries.push(entry);
		this.presentationById.set(entry.id, entry);
		this.activeAssistantPresentation = entry;
		return entry;
	}

	/** Apply JSON/RPC assistant text deltas and completed-block replacements by content index. */
	private updateAssistantPresentation(update: NonNullable<ParsedEvent["assistantMessageEvent"]>): void {
		if (!new Set(["text_start", "text_delta", "text_end"]).has(update.type ?? "")) return;
		const entry = this.beginAssistantPresentation();
		const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
		if (update.type === "text_start") this.assistantTextBlocks.set(index, "");
		else if (update.type === "text_delta") {
			this.assistantTextBlocks.set(index, `${this.assistantTextBlocks.get(index) ?? ""}${sanitizePresentationText(update.delta)}`);
		} else {
			// JSON/RPC text_end content is authoritative for this streamed block.
			this.assistantTextBlocks.set(index, sanitizePresentationText(update.content));
		}
		entry.text = [...this.assistantTextBlocks.entries()]
			.sort(([left], [right]) => left - right)
			.map(([, value]) => value)
			.filter(Boolean)
			.join("\n")
			.trim();
	}

	/** Replace the live assistant entry with the authoritative final assistant message. */
	private completeAssistantPresentation(text: string): void {
		const entry = this.activeAssistantPresentation ?? (text ? this.beginAssistantPresentation() : undefined);
		if (!entry) return;
		entry.text = text;
		entry.status = "completed";
		this.assistantTextBlocks.clear();
		this.activeAssistantPresentation = undefined;
	}

	/** Reuse one ordered presentation record per tool call while preserving child-call relationships. */
	private ensureToolPresentation(toolCallId: string, toolName: string, args: unknown, parentToolCallId?: string): WorkerPresentationEntry {
		const id = `tool-${toolCallId}`;
		const existing = this.presentationById.get(id);
		if (existing) return existing;
		const action = this.activeActions.get(toolCallId);
		const entry: WorkerPresentationEntry = {
			id,
			kind: "tool",
			label: action?.label ?? formatActivity(toolName, args),
			status: "running",
			text: "",
			parentToolCallId,
		};
		this.presentationEntries.push(entry);
		this.presentationById.set(id, entry);
		return entry;
	}

	/** Format retained presentation entries from their latest state without retaining repeated partial snapshots. */
	private presentationText(): string {
		return this.presentationEntries
			.map((entry) => {
				if (entry.kind === "assistant") {
					if (!entry.text) return "";
					return `${entry.status === "streaming" ? "assistant streaming" : "assistant"}:\n${entry.text}`;
				}
				const kind = entry.parentToolCallId ? "child tool" : "tool";
				const lines = [`${kind} start: ${entry.label}`];
				if (entry.status === "running") {
					if (entry.text) lines.push(`${kind} update: ${entry.label}`, entry.text);
				} else {
					lines.push(`${kind} ${entry.status}: ${entry.label}`);
					if (entry.text) lines.push(entry.text);
				}
				return lines.join("\n");
			})
			.filter(Boolean)
			.join("\n\n");
	}

	/** Execute one or more supervised action batches while respecting calculated ceilings. */
	private async runStages(
		initialMessage: string,
		actionBatches: number,
		rootToolCallId: string,
		signal: AbortSignal | undefined,
		onProgress: (snapshot: WorkerSnapshot) => void,
		ctx: ExtensionToolContext,
	): Promise<WorkerSnapshot> {
		const lease = this.openExecutorLease(rootToolCallId, ctx, signal);
		try {
			let message = initialMessage;
		for (let batch = 0; batch < actionBatches; batch++) {
			this.assertBudget();
			const actionBaseline = this.actionSequence;
			if (signal?.aborted) {
				await this.stop("cancelled", "parent operation was already aborted");
				throw new Error("Parent operation was already aborted.");
			}
			this.status = "running";
			this.progressCallback = onProgress;
			this.diagnostic = undefined;
			this.activeStartedAt = Date.now();
			this.phase = batch === 0 ? "worker turn" : "leased continuation";
			this.recommendation = "wait for boundary";
			onProgress(this.snapshot());
			this.boundaryObserved = false;
			this.lastStopReason = undefined;
			this.settleWaiter = undefined;
			const settled = new Promise<void>((resolve, reject) => {
				this.settleWaiter = { resolve, reject };
			});
			const boundary = new Promise<void>((resolve, reject) => {
				this.boundaryWaiter = { resolve, reject };
			});
			// Mark deferred rejections as observed even if cancellation beats prompt acceptance.
			void settled.catch(() => undefined);
			void boundary.catch(() => undefined);
			const abort = () => {
				const error = new Error("Parent operation aborted.");
				this.settleWaiter?.reject(error);
				void this.stop("cancelled", "parent operation aborted");
			};
			signal?.addEventListener("abort", abort, { once: true });
			try {
				const operation = (async () => {
					const prompt = await this.request("prompt", { type: "prompt", message }, this.operationTimeout(30_000));
					if (!prompt.success) throw new Error(prompt.error || "Worker rejected the prompt.");
					if (!isRecord(prompt.data) || typeof prompt.data.disposition !== "string") {
						throw new Error("Worker prompt response omitted its disposition.");
					}
					if (prompt.data.disposition === "handled") throw new Error("Worker prompt was intercepted by an input handler; no agent run started.");
					await settled;
				})();
				await this.waitForSettlement(operation);
				if (!this.boundaryObserved && this.actionSequence > actionBaseline) {
					await Promise.race([
						boundary,
						new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Worker tool turn settled without an enforced IPC boundary.")), 2_000)),
					]);
				}
			} finally {
				signal?.removeEventListener("abort", abort);
				this.settleWaiter = undefined;
				this.boundaryWaiter = undefined;
				this.progressCallback = undefined;
				this.commitActiveElapsed();
			}
			await this.refreshStats();
			// Classify tool-free settlement while preserving output-limit responses for recovery.
			if (!this.boundaryObserved) {
				if (this.lastStopReason === "length") {
					this.status = "paused";
					this.phase = "worker response reached its output limit";
					this.recommendation = "continue to recover the truncated response, revise, checkpoint, cancel, or take over";
					this.schedulePausedLease();
					return this.snapshot();
				}
				this.status = this.lastStopReason === "stop" ? "completed" : "failed";
				this.phase = this.status === "completed" ? "worker completed" : `worker stopped with ${this.lastStopReason ?? "no final reason"}`;
				this.recommendation = this.status === "completed" ? "review and integrate" : "inspect failure";
				const snapshot = this.snapshot();
				await this.dispose();
				return snapshot;
			}
			if (batch + 1 < actionBatches) {
				message = "Continue from the completed action batch without repeating completed work.";
				continue;
			}
			this.status = "paused";
			this.phase = "safe post-tool-batch boundary";
			this.recommendation = this.contextRecommendation();
			this.schedulePausedLease();
			return this.snapshot();
		}
			throw new Error("Unreachable supervised stage state.");
		} finally {
			this.clearExecutorLease(lease);
		}
	}

	/** Wait for settlement while enforcing job deadline and no-progress policy externally. */
	private async waitForSettlement(settled: Promise<void>): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const monitor = setInterval(() => {
				const now = Date.now();
				this.emitProgress();
				if (this.currentActiveElapsedMs() >= this.budget.seconds * 1_000) {
					clearInterval(monitor);
					void this.stop("hard_stopped", "calculated absolute job deadline reached");
					reject(new Error("Calculated absolute job deadline reached."));
					return;
				}
				if (now - this.lastProgressAt >= this.policy.noProgressSeconds * 1_000) {
					clearInterval(monitor);
					void this.stop("hard_stopped", "worker made no observable progress within policy");
					reject(new Error("Worker no-progress policy elapsed."));
				}
			}, 1_000);
			settled.then(
				() => { clearInterval(monitor); resolve(); },
				(error) => { clearInterval(monitor); reject(error); },
			);
		});
	}

	/** Reject work that has reached a calculated or administrative boundary. */
	private assertBudget(): void {
		if (this.turns >= this.budget.turns) throw new Error(`Calculated turn budget ${this.budget.turns} is exhausted.`);
		if (this.currentActiveElapsedMs() >= this.budget.seconds * 1_000) throw new Error(`Calculated active-time budget ${this.budget.seconds}s is exhausted.`);
	}

	/** Ask the idle RPC child for authoritative current context statistics. */
	private async refreshStats(): Promise<void> {
		try {
			const response = await this.request("get_session_stats", { type: "get_session_stats" }, this.operationTimeout(30_000));
			if (!response.success || !isRecord(response.data)) return;
			const usage = response.data.contextUsage;
			if (!isRecord(usage)) return;
			if (typeof usage.tokens === "number") this.context.tokens = usage.tokens;
			if (typeof usage.contextWindow === "number") this.context.contextWindow = usage.contextWindow;
			if (typeof usage.percent === "number") {
				this.context.percent = usage.percent;
				this.context.peakPercent = Math.max(this.context.peakPercent, usage.percent);
			}
		} catch (error) {
			this.diagnostic = `Context statistics unavailable: ${error instanceof Error ? error.message : String(error)}`;
			if (isTerminal(this.status)) throw error;
		}
	}

	/** Recommend the next manager action from context pressure and remaining budget. */
	private contextRecommendation(): string {
		const remainingTurns = this.budget.turns - this.turns;
		const remainingSeconds = this.budget.seconds - Math.ceil(this.currentActiveElapsedMs() / 1_000);
		if (remainingTurns <= 0 || remainingSeconds <= 0) return "checkpoint or take over: calculated budget exhausted";
		if (remainingTurns <= 2 || remainingSeconds <= 120) return "finalize now, recalculate remaining workload, checkpoint, or take over";
		if ((this.context.percent ?? 0) >= 75) return "compact worker context before continuing";
		if (this.actions.some((action) => action.status === "failed")) return "inspect failure before continuing";
		return "continue, revise, compact, checkpoint, cancel, or take over";
	}

	/** Rebuild the grant from this invocation's callable manager tools before a worker can resume. */
	private revalidateManifest(ctx: ExtensionToolContext): void {
		const current = buildDelegatedToolManifests(this.tools, this.pi, ctx);
		if (current.length !== this.manifests.length) throw new Error("the selected tool count changed");
		const currentIdentities = new Map(ctx.tools.map((tool) => [tool.name, tool]));
		for (let index = 0; index < current.length; index++) {
			const expected = this.manifests[index];
			const observed = current[index];
			if (expected.name !== observed.name || expected.fingerprint !== observed.fingerprint) {
				throw new Error(`selected tool ${expected.name} is no longer definition-compatible`);
			}
			if (expected.name !== "codemode" && this.callableIdentityByName.get(expected.name) !== currentIdentities.get(expected.name)) {
				throw new Error(`selected tool ${expected.name} no longer has the original callable identity`);
			}
		}
	}

	/** Enforce selected capabilities during a lease and reject delayed calls from every revoked lease. */
	authorizeNestedToolCall(parentToolCallId: string | undefined, toolName: string): { block: boolean; reason: string } | undefined {
		if (!parentToolCallId) return undefined;
		const lease = this.executorLease;
		if (lease && (parentToolCallId === lease.rootToolCallId || parentToolCallId.startsWith(`${lease.rootToolCallId}/`))) {
			if (toolName === "codemode" || !this.manifestByName.has(toolName)) {
				return { block: true, reason: `Nested manager tool ${toolName} is outside this delegation's selected capability grant.` };
			}
			return undefined;
		}
		return revokedExecutorDecision(parentToolCallId, toolName);
	}

	/** Grant parent execution only while a start or continuation call actively owns the worker. */
	private openExecutorLease(rootToolCallId: string, ctx: ExtensionToolContext, signal: AbortSignal | undefined): ExecutorLease {
		if (this.executorLease) throw new Error("A manager executor lease is already active for this worker.");
		const lease: ExecutorLease = { rootToolCallId, ctx, signal };
		this.executorLease = lease;
		return lease;
	}

	/** Revoke parent execution before exposing an idle, paused, or terminal worker state. */
	private clearExecutorLease(expected?: ExecutorLease): void {
		if (expected && this.executorLease !== expected) return;
		const lease = this.executorLease;
		if (!lease) return;
		this.executorLease = undefined;
		revokeExecutorRoot(lease.rootToolCallId);
		for (const [requestId, request] of this.proxyRequests) {
			if (request.lease !== lease) continue;
			this.proxyRequests.delete(requestId);
			request.removeParentAbort?.();
			request.removeParentAbort = undefined;
			request.controller.abort();
		}
	}

	/** Deliver a nonce-bound manager result or streaming update to the private child proxy. */
	private sendProxy(message: Record<string, unknown>): void {
		try {
			if (this.child?.connected) this.child.send(message);
		} catch {
			// Child teardown wins over a late nested-tool result.
		}
	}

	/** Reject a malformed, stale, replayed, cross-job, or otherwise unauthorized proxy call. */
	private rejectProxyRequest(requestId: unknown, reason: string): void {
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return;
		this.sendProxy({
			type: "task_dispatcher_proxy_result",
			nonce: this.proxyNonce,
			requestId,
			result: proxyErrorResult(reason),
		});
	}

	/** Start one parent-side nested tool call while preserving manager hooks, validation, and cancellation. */
	private async handleProxyRequest(message: Record<string, unknown>): Promise<void> {
		const requestId = message.requestId;
		if (message.nonce !== this.proxyNonce) {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because its job nonce is invalid.");
			return;
		}
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return;
		if (this.seenProxyRequests.has(requestId)) {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because its request id was replayed.");
			return;
		}
		if (this.seenProxyRequests.size >= PROXY_MAX_REQUESTS_PER_JOB) {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because the per-job request limit was reached.");
			return;
		}
		this.seenProxyRequests.add(requestId);
		const lease = this.executorLease;
		if (!lease || this.status !== "running") {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because no bounded manager executor lease is active.");
			return;
		}
		if (typeof message.toolName !== "string" || message.toolName === "codemode" || !this.manifestByName.has(message.toolName)) {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because the requested tool is not in this job's selected capability grant.");
			return;
		}
		if (this.proxyRequests.size >= PROXY_MAX_IN_FLIGHT_REQUESTS) {
			this.rejectProxyRequest(requestId, "Worker proxy request was rejected because too many manager executions are in flight.");
			return;
		}
		try {
			this.revalidateManifest(lease.ctx);
		} catch (error) {
			const reason = `Delegated tool grant changed before ${message.toolName} execution: ${error instanceof Error ? error.message : String(error)}`;
			this.rejectProxyRequest(requestId, reason);
			void this.stop("hard_stopped", reason);
			return;
		}
		let args: JsonValue;
		try {
			args = cloneJsonValue(message.args, `worker proxy arguments for ${message.toolName}`);
			assertJsonByteLimit(args, `worker proxy arguments for ${message.toolName}`, PROXY_PAYLOAD_LIMIT_BYTES);
		} catch (error) {
			this.rejectProxyRequest(requestId, `Worker proxy request arguments are invalid: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const controller = new AbortController();
		const abortFromParent = () => controller.abort();
		if (lease.signal?.aborted) controller.abort();
		else lease.signal?.addEventListener("abort", abortFromParent, { once: true });
		const request: ProxyRequestState = {
			lease,
			controller,
			removeParentAbort: lease.signal ? () => lease.signal?.removeEventListener("abort", abortFromParent) : undefined,
		};
		this.proxyRequests.set(requestId, request);
		try {
			const outcome = await lease.ctx.executeTool(message.toolName as string, args, {
				signal: controller.signal,
				onUpdate: (partial) => {
					if (this.executorLease !== lease || this.proxyRequests.get(requestId) !== request) return;
					this.sendProxy({
						type: "task_dispatcher_proxy_update",
						nonce: this.proxyNonce,
						requestId,
						result: serializeProxyResult(partial),
					});
				},
			});
			if (this.executorLease === lease && this.proxyRequests.get(requestId) === request) {
				this.sendProxy({
					type: "task_dispatcher_proxy_result",
					nonce: this.proxyNonce,
					requestId,
					result: serializeProxyResult(outcome.result, outcome.isError),
				});
			}
		} catch (error) {
			if (this.executorLease === lease && this.proxyRequests.get(requestId) === request) {
				this.sendProxy({
					type: "task_dispatcher_proxy_result",
					nonce: this.proxyNonce,
					requestId,
					result: proxyErrorResult(`Manager execution of ${message.toolName as string} failed: ${error instanceof Error ? error.message : String(error)}`),
				});
			}
		} finally {
			request.removeParentAbort?.();
			request.removeParentAbort = undefined;
			if (this.proxyRequests.get(requestId) === request) this.proxyRequests.delete(requestId);
		}
	}

	/** Propagate a child-side proxy cancellation to the current manager nested-tool signal. */
	private handleProxyCancel(message: Record<string, unknown>): void {
		const requestId = message.requestId;
		if (message.nonce !== this.proxyNonce) {
			this.rejectProxyRequest(requestId, "Worker proxy cancellation was rejected because its job nonce is invalid.");
			return;
		}
		if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return;
		const request = this.proxyRequests.get(requestId);
		if (!request || request.lease !== this.executorLease || this.status !== "running") {
			this.rejectProxyRequest(requestId, "Worker proxy cancellation was rejected because the request is unknown or no longer active.");
			return;
		}
		request.controller.abort();
	}

	/** Correlate one RPC request; an uncertain timeout closes the worker rather than permitting a racing command. */
	private async request(label: string, payload: Record<string, unknown>, timeoutMs: number): Promise<ParsedEvent> {
		const child = this.child;
		if (!child?.stdin || child.stdin.writableEnded) throw new Error("Worker RPC input is closed.");
		const id = `dispatcher-${label}-${++this.requestSequence}`;
		const response = new Promise<ParsedEvent>((resolve, reject) => this.pendingRequests.set(id, { resolve, reject }));
		child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				response,
				new Promise<ParsedEvent>((_, reject) => {
					timer = setTimeout(() => {
						const error = new Error(`Worker RPC ${label} timed out; worker closed to prevent a command race.`);
						void this.stop("hard_stopped", error.message);
						reject(error);
					}, Math.max(1, timeoutMs));
				}),
			]);
		} finally {
			if (timer) clearTimeout(timer);
			this.pendingRequests.delete(id);
		}
	}

	/** Reject all consumers when the worker process can no longer produce state. */
	private failPending(error: Error): void {
		this.clearExecutorLease();
		for (const pending of this.pendingRequests.values()) pending.reject(error);
		this.pendingRequests.clear();
		this.settleWaiter?.reject(error);
		this.boundaryWaiter?.reject(error);
	}

	/** Close abandoned paused jobs so extension reload and manager inaction cannot orphan workers. */
	private schedulePausedLease(): void {
		this.clearPausedLease();
		this.pausedLease = setTimeout(() => {
			if (this.status === "paused") void this.stop("checkpointed", "paused-job lease expired");
		}, this.policy.pausedLeaseSeconds * 1_000);
	}

	/** Cancel the current paused-job lease before a state transition. */
	private clearPausedLease(): void {
		if (this.pausedLease) clearTimeout(this.pausedLease);
		this.pausedLease = undefined;
	}

	/** Remove runtime-only worker instructions after process termination without touching workspace artifacts. */
	private async removeTemporaryDirectory(): Promise<void> {
		if (this.temporaryRemoval) return await this.temporaryRemoval;
		const directory = this.temporaryDirectory;
		this.temporaryDirectory = undefined;
		if (!directory) return;
		this.temporaryRemoval = fs.promises.rm(directory, { recursive: true, force: true });
		return await this.temporaryRemoval;
	}

	/** Coalesce token and partial-result bursts before rebuilding and serializing the complete snapshot. */
	private scheduleProgressUpdate(): void {
		if (this.progressUpdate) return;
		this.progressUpdate = setTimeout(() => {
			this.progressUpdate = undefined;
			this.emitProgress();
		}, PRESENTATION_UPDATE_THROTTLE_MS);
	}

	/** Refresh the partial tool block with elapsed time and the latest active command. */
	private emitProgress(): void {
		if (this.progressUpdate) clearTimeout(this.progressUpdate);
		this.progressUpdate = undefined;
		try {
			this.progressCallback?.(this.snapshot());
		} catch {
			// Rendering feedback must never alter worker control flow.
		}
	}

	/** Bound control-channel waits by both the requested limit and remaining active-time policy. */
	private operationTimeout(requestedMs: number): number {
		return Math.max(1, Math.min(requestedMs, this.remainingMilliseconds(), this.policy.noProgressSeconds * 1_000));
	}

	/** Calculate remaining active time for bounded RPC-side maintenance operations. */
	private remainingMilliseconds(): number {
		return Math.max(1, this.budget.seconds * 1_000 - this.currentActiveElapsedMs());
	}

	/** Measure only delegated execution and compaction time; manager deliberation has its own paused lease. */
	private currentActiveElapsedMs(): number {
		return this.activeElapsedMs + (this.activeStartedAt === undefined ? 0 : Date.now() - this.activeStartedAt);
	}

	/** Commit one active interval exactly once before entering an idle or paused state. */
	private commitActiveElapsed(): void {
		if (this.activeStartedAt === undefined) return;
		this.activeElapsedMs += Date.now() - this.activeStartedAt;
		this.activeStartedAt = undefined;
	}
}

let activeJob: WorkerJob | undefined;

/** Return a paused job's exact fixed grant only for controls that can resume that job. */
function continuationDelegatedReachability(input: unknown): readonly string[] {
	if (!isRecord(input) || (input.action !== "continue" && input.action !== "revise") || typeof input.jobId !== "string") return [];
	const job = activeJob;
	if (!job || job.id !== input.jobId || job.status !== "paused") return [];
	return [...job.tools];
}

let lastSnapshot: WorkerSnapshot | undefined;
const latestRoleSnapshots = new Map<Role, WorkerSnapshot>();
let reportedUsage: { jobId: string; usage: UsageTotals } | undefined;

/** Resolve role overrides against the active parent model without assuming provider availability. */
function resolveWorkerConfig(config: WorkerRoleConfig, ctx: ExtensionToolContext): { role: ResolvedWorkerRoleConfig; contextWindow: number; maxTokens: number } {
	let model = ctx.model;
	if (config.model) {
		const separator = config.model.indexOf("/");
		const provider = config.model.slice(0, separator);
		const modelId = config.model.slice(separator + 1);
		model = ctx.modelRegistry.find(provider, modelId);
		if (!model) throw new Error(`Configured model ${config.model} was not found. Configuration: ${CONFIG_PATH}`);
	}
	if (!model) throw new Error("No active model is available; select a model or configure a role override.");
	if (!ctx.modelRegistry.hasConfiguredAuth(model)) throw new Error(`Selected model ${model.provider}/${model.id} has no authentication.`);
	return {
		role: {
			model: `${model.provider}/${model.id}`,
			thinking: config.thinking ?? ctx.thinkingLevel ?? "medium",
		},
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

/** Build exact child manifests from manager-callable tools plus the explicitly active child-local codemode. */
function buildDelegatedToolManifests(requested: string[], pi: ExtensionAPI, ctx: ExtensionToolContext): DelegatedToolManifest[] {
	const malformed = requested.filter((name) => name.trim() !== name || name.length === 0);
	if (malformed.length > 0) throw new Error(`Delegated tool names must be exact nonempty names: ${malformed.join(", ")}`);
	const duplicates = requested.filter((name, index) => requested.indexOf(name) !== index);
	if (duplicates.length > 0) throw new Error(`Delegated tool names must not be repeated: ${[...new Set(duplicates)].join(", ")}`);
	const forbidden = new Set([...Object.values(ROLE_TOOL_NAMES), "delegate_control", "delegate_status"]);
	const recursive = requested.filter((name) => forbidden.has(name));
	if (recursive.length > 0) throw new Error(`Delegation tools cannot be delegated recursively: ${recursive.join(", ")}`);
	if (typeof ctx.executeTool !== "function") throw new Error("The current manager tool context does not expose ctx.executeTool().");
	const callable = new Map(ctx.tools.map((tool) => [tool.name, tool]));
	const metadata = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const active = new Set(pi.getActiveTools());
	const unavailable = requested.filter((name) => name === "codemode"
		? !active.has(name) || !metadata.has(name)
		: !callable.has(name));
	if (unavailable.length > 0) {
		const detail = unavailable.map((name) => {
			if (name === "codemode" && metadata.has(name)) return `${name} (registered but not active in the manager)`;
			return metadata.has(name)
				? `${name} (registered but not callable through ctx.executeTool())`
				: `${name} (not registered or callable through ctx.executeTool())`;
		});
		throw new Error(`Requested delegated tools are unavailable: ${detail.join(", ")}`);
	}
	const manifests = requested.map((name) => {
		const localCodemode = name === "codemode";
		const tool = callable.get(name);
		const info = metadata.get(name);
		if (!info) throw new Error(`Delegated tool ${name} does not expose registered public metadata.`);
		const label = localCodemode ? "Codemode" : tool?.label;
		const description = localCodemode ? info.description : tool?.description;
		if (typeof label !== "string" || typeof description !== "string") {
			throw new Error(`Delegated tool ${name} does not expose serializable label and description metadata.`);
		}
		const parameters = cloneJsonValue(localCodemode ? info.parameters : tool?.parameters, `${name} parameter schema`);
		if (!isRecord(parameters)) throw new Error(`Delegated tool ${name} parameter schema must be a JSON object.`);
		const outputSchema = localCodemode || tool?.outputSchema === undefined
			? undefined
			: cloneJsonValue(tool.outputSchema, `${name} output schema`);
		const rawSourceInfo = info.sourceInfo;
		if (!isRecord(rawSourceInfo)
			|| typeof rawSourceInfo.path !== "string"
			|| typeof rawSourceInfo.source !== "string"
			|| !new Set(["user", "project", "temporary"]).has(rawSourceInfo.scope as string)
			|| !new Set(["package", "top-level"]).has(rawSourceInfo.origin as string)
			|| (rawSourceInfo.baseDir !== undefined && typeof rawSourceInfo.baseDir !== "string")) {
			throw new Error(`Delegated tool ${name} has unsupported source metadata.`);
		}
		const sourceInfo = cloneJsonValue({
			path: rawSourceInfo.path,
			source: rawSourceInfo.source,
			scope: rawSourceInfo.scope,
			origin: rawSourceInfo.origin,
			...(rawSourceInfo.baseDir === undefined ? {} : { baseDir: rawSourceInfo.baseDir }),
		}, `${name} source metadata`);
		let namespace: ToolNamespaceManifest | undefined;
		if (info?.namespace !== undefined) {
			const rawNamespace = info.namespace;
			if (!isRecord(rawNamespace) || typeof rawNamespace.name !== "string" || rawNamespace.name.length === 0) {
				throw new Error(`Callable tool ${name} has unsupported namespace metadata.`);
			}
			if (rawNamespace.description !== undefined && typeof rawNamespace.description !== "string") throw new Error(`Callable tool ${name} has unsupported namespace description metadata.`);
			if (rawNamespace.instructions !== undefined && typeof rawNamespace.instructions !== "string") throw new Error(`Callable tool ${name} has unsupported namespace instructions metadata.`);
			const rawAliases = rawNamespace.aliases;
			let aliases: string[] | undefined;
			if (rawAliases !== undefined) {
				if (!Array.isArray(rawAliases)) throw new Error(`Callable tool ${name} has unsupported namespace aliases metadata.`);
				aliases = rawAliases.map((alias) => {
					if (typeof alias !== "string") throw new Error(`Callable tool ${name} has unsupported namespace aliases metadata.`);
					return alias;
				});
			}
			namespace = {
				name: rawNamespace.name,
				...(rawNamespace.description === undefined ? {} : { description: rawNamespace.description }),
				...(rawNamespace.instructions === undefined ? {} : { instructions: rawNamespace.instructions }),
				...(aliases === undefined ? {} : { aliases }),
			};
		}
		let annotations: ToolAnnotationsManifest | undefined;
		if (info?.annotations !== undefined) {
			if (!isRecord(info.annotations)) throw new Error(`Callable tool ${name} has unsupported annotations metadata.`);
			annotations = {};
			for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
				const value = info.annotations[key];
				if (value !== undefined && typeof value !== "boolean") throw new Error(`Callable tool ${name} has unsupported ${key} metadata.`);
				if (value !== undefined) annotations[key] = value;
			}
		}
		let promptGuidelines: string[] | undefined;
		if (info?.promptGuidelines !== undefined) {
			if (!Array.isArray(info.promptGuidelines) || info.promptGuidelines.some((guideline) => typeof guideline !== "string")) {
				throw new Error(`Callable tool ${name} has unsupported prompt guideline metadata.`);
			}
			promptGuidelines = [...info.promptGuidelines];
		}
		const executionMode = localCodemode ? "sequential" : tool?.executionMode;
		if (executionMode !== undefined && executionMode !== "sequential" && executionMode !== "parallel") {
			throw new Error(`Delegated tool ${name} has unsupported execution-mode metadata.`);
		}
		const manifest: Omit<DelegatedToolManifest, "fingerprint"> = {
			name,
			label,
			description,
			parameters,
			...(outputSchema === undefined ? {} : { outputSchema }),
			...(namespace === undefined ? {} : { namespace }),
			...(annotations === undefined ? {} : { annotations }),
			...(promptGuidelines === undefined ? {} : { promptGuidelines }),
			...(executionMode === undefined ? {} : { executionMode }),
		};
		return {
			...manifest,
			// Preserve namespace aliases in the immutable compatibility surface checked before every resume.
			fingerprint: stableJson(cloneJsonValue({ ...manifest, sourceInfo }, `${name} delegated manifest`)),
		};
	});
	assertJsonByteLimit(manifests as unknown as JsonValue, "delegated tool manifest", PROXY_MANIFEST_LIMIT_BYTES);
	return manifests;
}

/** Format context pressure against the worker model's own physical context window. */
function formatContext(snapshot: WorkerSnapshot): string {
	const window = snapshot.context.contextWindow;
	const windowLabel = window >= 1_000_000
		? `${Number((window / 1_000_000).toFixed(1))}m`
		: `${Math.round(window / 1_000)}k`;
	return `${snapshot.context.percent?.toFixed(1) ?? "?"}%/${windowLabel} context`;
}

/** Format active execution duration without counting time paused for manager decisions. */
function formatElapsed(durationMs: number): string {
	const seconds = Math.ceil(durationMs / 1_000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Use Pi's configured expansion binding when interactive UI state exists, with a harmless noninteractive render fallback. */
function expansionHint(theme: any): string {
	try {
		return keyHint("app.tools.expand", "to expand");
	} catch {
		return theme.fg("muted", "to expand");
	}
}

/** Format one bounded state report for both model consumption and non-TUI modes. */
function formatSnapshot(snapshot: WorkerSnapshot): string {
	const context = snapshot.context.percent === undefined
		? `${snapshot.context.contextWindow.toLocaleString()} window; usage unavailable`
		: `${snapshot.context.tokens?.toLocaleString() ?? "?"}/${snapshot.context.contextWindow.toLocaleString()} (${snapshot.context.percent.toFixed(1)}%)`;
	const recent = snapshot.recentActions.length > 0
		? snapshot.recentActions.map((action) => `${action.status}: ${action.label}`).join("; ")
		: "none";
	const worker = snapshot.workerTextDisplay ? `\nWorker text:\n${snapshot.workerTextDisplay}` : "";
	return [
		`State: ${snapshot.status}`,
		`- Job: ${snapshot.jobId}`,
		`- Task: ${snapshot.taskDisplay}`,
		`- Role/model: ${snapshot.role} via ${snapshot.model} (${snapshot.thinking})`,
		`- Boundary: ${snapshot.sequence}; phase: ${snapshot.phase}`,
		snapshot.currentActivity ? `- Now: ${snapshot.currentActivity}` : "",
		`- Actions: ${snapshot.actionCounts.completed} completed, ${snapshot.actionCounts.failed} failed, ${snapshot.actionCounts.mutations} potentially mutating`,
		`- Recent: ${recent}`,
		`- Budget: ${snapshot.turns}/${snapshot.budget.turns} turns; ${Math.ceil(snapshot.durationMs / 1_000)}/${snapshot.budget.seconds}s`,
		`- Context: ${formatContext(snapshot)} (${context}); compactions: ${snapshot.context.compactions} completed, ${snapshot.context.compactionSkips} skipped, ${snapshot.context.compactionFailures} failed (${snapshot.context.compactionAttempts} attempts)`,
		`- Recommendation: ${snapshot.recommendation}`,
		snapshot.diagnostic ? `- Diagnostic: ${snapshot.diagnostic}` : "",
		worker,
	].filter(Boolean).join("\n");
}

/** Keep one unindented footer line with the most recent state observed for every invoked role. */
function updateWorkerStatus(ctx: ExtensionToolContext, snapshot: WorkerSnapshot): void {
	latestRoleSnapshots.delete(snapshot.role);
	latestRoleSnapshots.set(snapshot.role, snapshot);
	if (!ctx.hasUI) return;
	// Clear the pre-3.1 editor widget if this extension was reloaded in place.
	ctx.ui.setWidget(WIDGET_ID, undefined);
	const status = [...latestRoleSnapshots.values()]
		.reverse()
		.map((roleSnapshot) => {
			const model = roleSnapshot.model.slice(roleSnapshot.model.indexOf("/") + 1);
			const context = formatContext(roleSnapshot).replace(/ context$/, "");
			return `${roleSnapshot.jobId} · ${context} • ${model} • ${roleSnapshot.thinking}`;
		})
		.join(" | ");
	ctx.ui.setStatus(WIDGET_ID, ctx.ui.theme.fg("dim", status));
}

/** Obtain mutable state shared by call/result renderers, including during partial argument streaming. */
function rendererState(context: any): Record<string, unknown> {
	if (!isRecord(context.state)) context.state = {};
	return context.state;
}

/** Format partial delegate arguments without assuming every streamed field is present yet. */
function renderArgumentSummary(value: unknown): { task: string; workload: string } {
	if (!isRecord(value)) return { task: "Preparing delegation…", workload: "workload pending" };
	const tools = Array.isArray(value.tools) ? value.tools.length : 0;
	const workload = isRecord(value.workload) ? value.workload : {};
	const investigation = typeof workload.investigationUnits === "number" ? workload.investigationUnits : "?";
	const change = typeof workload.changeUnits === "number" ? workload.changeUnits : "?";
	const verification = typeof workload.verificationUnits === "number" ? workload.verificationUnits : "?";
	return { task: compactLine(value.task), workload: `${tools} tools · ${investigation}/${change}/${verification} I/C/V units` };
}

/** Reuse dynamic text components while changing their source only outside the TUI render cycle. */
class DynamicTextComponent {
	private readonly text = new Text("", 0, 0);
	private currentText: string | undefined;
	private build: () => string;

	constructor(build: () => string) {
		this.build = build;
	}

	setBuild(build: () => string): void {
		this.build = build;
	}

	render(width: number): string[] {
		let nextText: string;
		try {
			nextText = this.build();
		} catch {
			nextText = "Preparing delegation…";
		}
		// Text.setText() invalidates the TUI, so call it only when observable content changed.
		if (nextText !== this.currentText) {
			this.currentText = nextText;
			this.text.setText(nextText);
		}
		return this.text.render(width);
	}

	invalidate(): void {
		this.text.invalidate();
	}
}

/** Reuse the call-renderer component from Pi's context instead of allocating one for every update. */
function dynamicText(context: any, build: () => string, stateKey = "callComponent"): Component {
	const state = rendererState(context);
	const previous = context.lastComponent;
	const component = previous instanceof DynamicTextComponent
		? previous
		: state[stateKey] instanceof DynamicTextComponent
			? state[stateKey] as DynamicTextComponent
			: new DynamicTextComponent(build);
	component.setBuild(build);
	state[stateKey] = component;
	return component;
}

/** Render the full presentation ledger with Pi's native visual-row truncation and expansion hint. */
class DelegateResultComponent {
	private snapshot: WorkerSnapshot | undefined;
	private expanded = false;
	private isPartial = false;
	private standalone = false;
	private theme: any = undefined;
	private signature = "";
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	update(snapshot: WorkerSnapshot, expanded: boolean, isPartial: boolean, theme: any, standalone: boolean): void {
		const presentation = snapshot.presentationText ?? "";
		const signature = [
			snapshot.jobId,
			snapshot.status,
			snapshot.taskDisplay,
			snapshot.phase,
			snapshot.sequence,
			snapshot.turns,
			snapshot.durationMs,
			snapshot.currentActivity ?? "",
			snapshot.actionCounts.completed,
			snapshot.actionCounts.failed,
			snapshot.recommendation,
			presentation,
			expanded,
			isPartial,
			standalone,
		].join("\u0000");
		if (this.signature === signature && this.theme === theme) return;
		this.snapshot = snapshot;
		this.expanded = expanded;
		this.isPartial = isPartial;
		this.standalone = standalone;
		this.theme = theme;
		this.signature = signature;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedLines) return this.cachedLines;
		const snapshot = this.snapshot;
		if (!snapshot) return [];
		const color = snapshot.status === "paused" ? "warning" : snapshot.status === "completed" ? "success" : isTerminal(snapshot.status) && snapshot.status !== "completed" ? "error" : "accent";
		const latestActivity = snapshot.currentActivity ?? snapshot.recentActions.at(-1)?.label;
		const activityLabel = snapshot.currentActivity ? "Now" : "Last";
		const header = [
			this.standalone ? this.theme.fg(color, this.theme.bold(`${snapshot.jobId}: ${snapshot.status}`)) : "",
			this.standalone ? this.theme.fg("muted", `Task: ${snapshot.taskDisplay}`) : "",
			latestActivity ? this.theme.fg(snapshot.currentActivity ? "warning" : "muted", `${activityLabel}: ${latestActivity}`) : "",
			this.theme.fg("dim", `${snapshot.phase} · boundary ${snapshot.sequence} · turn ${snapshot.turns}/${snapshot.budget.turns}`),
			this.theme.fg("muted", `${snapshot.actionCounts.completed} actions complete · ${snapshot.actionCounts.failed} failed · ${formatContext(snapshot)}`),
			this.theme.fg("accent", snapshot.recommendation),
		].filter(Boolean).join("\n");
		const lines = new Text(header, 0, 0).render(width);
		const presentation = snapshot.presentationText ?? "";
		if (presentation) {
			// Reapply styling per line because Pi resets terminal attributes at every rendered row.
			const styledPresentation = presentation
				.split("\n")
				.map((line) => this.theme.fg("dim", line))
				.join("\n");
			if (this.expanded) {
				lines.push("", ...new Text(styledPresentation, 0, 0).render(width));
			} else {
				const preview = truncateToVisualLines(styledPresentation, PRESENTATION_PREVIEW_ROWS, width, 0, "end");
				if (preview.visualLines.length > 0) {
					lines.push("");
					if (preview.skippedCount > 0) {
						const hint = this.theme.fg("muted", `… ${preview.skippedCount} earlier visual rows omitted (`)
							+ expansionHint(this.theme)
							+ this.theme.fg("muted", ")");
						lines.push(truncateToWidth(hint, width, "..."));
					}
					lines.push(...preview.visualLines);
				}
			}
		}
		lines.push(this.theme.fg("dim", `${this.isPartial ? "Elapsed" : "Took"}: ${formatElapsed(snapshot.durationMs)}`));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Render only nonredundant result details; the shared call header owns identity, task, and status. */
function renderWorkerResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown; isError?: boolean },
	expanded: boolean,
	isPartial: boolean,
	theme: any,
	context: any,
	standalone = false,
): Component {
	const snapshot = result.details as WorkerSnapshot | undefined;
	if (!snapshot) return dynamicText(context, () => theme.fg(isPartial ? "warning" : "muted", result.content[0]?.text ?? "Delegation state unavailable"), "resultTextComponent");
	const state = rendererState(context);
	state.snapshot = snapshot;
	const previous = context.lastComponent;
	const component = previous instanceof DelegateResultComponent
		? previous
		: state.resultComponent instanceof DelegateResultComponent
			? state.resultComponent as DelegateResultComponent
			: new DelegateResultComponent();
	component.update(snapshot, expanded, isPartial, theme, standalone);
	state.resultComponent = component;
	return component;
}

/** Package a snapshot as bounded model content plus complete machine-readable details. */
function snapshotResult(snapshot: WorkerSnapshot, isError = false): { content: Array<{ type: "text"; text: string }>; details: WorkerSnapshot; usage: UsageTotals; isError: boolean } {
	lastSnapshot = snapshot;
	const previous = reportedUsage && reportedUsage.jobId === snapshot.jobId
		? reportedUsage.usage
		: emptyUsage();
	const usage = usageDifference(snapshot.usage, previous);
	reportedUsage = { jobId: snapshot.jobId, usage: structuredClone(snapshot.usage) };
	return {
		content: [{ type: "text", text: formatSnapshot(snapshot) }],
		details: snapshot,
		usage,
		isError,
	};
}

/** Register one role-specific supervised worker starter. */
function registerDelegate(pi: ExtensionAPI, role: Role): void {
	const name = ROLE_TOOL_NAMES[role];
	pi.registerTool({
		name,
		label: ROLE_LABELS[role],
		description: ROLE_DESCRIPTIONS[role],
		promptSnippet: `${name}: start a supervised ${role} delegation that pauses after each completed action batch`,
		promptGuidelines: [
			...(role === "assistant"
				? ["When no other worker role applies, use delegate_assistant for the user-requested work instead of performing it directly. Retain delegation decisions, worker supervision, result integration, and the final response."]
				: []),
			CODEMODE_SELECTION_GUIDANCE,
			"Supply semantic workload units rather than raw turn or timeout values.",
			"Inspect every paused state and choose continue, revise, recalculate, compact, checkpoint, cancel, or take over.",
			"Worker reports remain evidence to review, not proof of correctness.",
		],
		// Advertise the validated child grant to Pi without serializing a reachability callback into a proxy manifest.
		...{ reachesTools: exactDelegatedReachability },
		parameters: DelegateParams,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		renderCall(args, theme, context) {
			const expectedId = `${role}-${nextJobIndex}`;
			return dynamicText(context, () => {
				const snapshot = rendererState(context).snapshot as WorkerSnapshot | undefined;
				const current = renderArgumentSummary(context.args ?? args);
				const id = snapshot?.jobId ?? expectedId;
				const status = snapshot?.status ?? "starting";
				return [
					theme.fg("toolTitle", theme.bold(`${id}: ${status}`)),
					theme.fg("muted", `Task: ${current.task}`),
					theme.fg("dim", current.workload),
				].join("\n");
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			return renderWorkerResult(result as any, expanded, isPartial, theme, context);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				if (activeJob && !isTerminal(activeJob.status)) throw new Error(`${activeJob.id} is still ${activeJob.status}.`);
				if (activeJob) {
					await activeJob.dispose();
					activeJob = undefined;
				}
				const config = loadConfig();
				const manifests = buildDelegatedToolManifests(params.tools, pi, ctx);
				const resolved = resolveWorkerConfig(config[role], ctx);
				const budget = calculateBudget(role, params.workload, resolved.contextWindow, resolved.maxTokens, config.policy);
				const job = new WorkerJob(role, params.task, manifests, resolved.role, ctx.cwd, config.policy, budget, pi, ctx.tools);
				activeJob = job;
				const progress = (snapshot: WorkerSnapshot) => {
					updateWorkerStatus(ctx, snapshot);
					onUpdate?.({ content: [{ type: "text", text: formatSnapshot(snapshot) }], details: snapshot });
				};
				const snapshot = await job.start(toolCallId, signal, progress, ctx);
				updateWorkerStatus(ctx, snapshot);
				return snapshotResult(snapshot, snapshot.status === "failed" || snapshot.status === "hard_stopped");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (activeJob && !isTerminal(activeJob.status)) await activeJob.stop("hard_stopped", message);
				const snapshot = activeJob?.snapshot();
				if (!snapshot) return { content: [{ type: "text", text: `Cannot start ${role}: ${message}` }], details: undefined, isError: true };
				updateWorkerStatus(ctx, snapshot);
				const result = snapshotResult(snapshot, true);
				result.content[0].text = `Cannot start ${role}: ${message}\n\n${result.content[0].text}`;
				return result;
			}
		},
	});
}

/** Register the explicit manager decisions that resume or close a paused delegation. */
function registerControl(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delegate_control",
		label: "Manager",
		description: "Control one paused supervised worker: continue, revise, recalculate, compact, take over, checkpoint, cancel.",
		promptSnippet: "delegate_control: make an explicit manager decision for a paused delegation",
		promptGuidelines: ["Use only after inspecting the latest worker boundary state.", "Takeover, cancellation, and ceilings are enforced by the dispatcher rather than worker compliance."],
		// Tie continuation reachability to the live paused job rather than a broader role or historical grant.
		...{ reachesTools: continuationDelegatedReachability },
		parameters: ControlParams,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		renderCall(args, theme, context) {
			return dynamicText(context, () => {
				const snapshot = rendererState(context).snapshot as WorkerSnapshot | undefined;
				const current = isRecord(context.args) ? context.args : isRecord(args) ? args : {};
				const jobId = typeof current.jobId === "string" ? current.jobId : "delegation";
				const action = typeof current.action === "string" ? current.action : "decision";
				const outcome = snapshot?.status ?? action;
				const lines = [theme.fg("toolTitle", theme.bold(`manager: ${jobId} → ${outcome}`))];
				if (typeof current.actionBatches === "number") lines.push(theme.fg("muted", `lease: ${current.actionBatches} action batches`));
				return lines.join("\n");
			});
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			return renderWorkerResult(result as any, expanded, isPartial, theme, context);
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			try {
				const job = activeJob;
				if (!job || job.id !== params.jobId) throw new Error(`No live delegation matches ${params.jobId}.`);
				let snapshot: WorkerSnapshot;
				if (params.action === "recalculate") {
					if (!params.workload) throw new Error("recalculate requires workload");
					snapshot = job.recalculate(params.workload);
				} else if (params.action === "compact") {
					snapshot = await job.compact();
				} else if (params.action === "take_over") {
					snapshot = await job.stop("taken_over", "manager requested takeover");
				} else if (params.action === "checkpoint") {
					snapshot = await job.stop("checkpointed", "manager requested synthetic checkpoint");
				} else if (params.action === "cancel") {
					snapshot = await job.stop("cancelled", "manager cancelled delegated work");
				} else {
					if (params.action === "revise" && !params.instructions) throw new Error("revise requires instructions");
					const progress = (state: WorkerSnapshot) => {
						state.managerAction = params.action;
						updateWorkerStatus(ctx, state);
						onUpdate?.({ content: [{ type: "text", text: formatSnapshot(state) }], details: state });
					};
					snapshot = await job.continue(params.action === "revise" ? params.instructions : undefined, params.actionBatches ?? 1, toolCallId, signal, progress, ctx);
				}
				snapshot.managerAction = params.action;
				updateWorkerStatus(ctx, snapshot);
				return snapshotResult(snapshot, snapshot.status === "failed" || snapshot.status === "hard_stopped");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const snapshot = activeJob?.snapshot();
				if (!snapshot) return { content: [{ type: "text", text: `Manager action failed: ${message}` }], details: undefined, isError: true };
				snapshot.managerAction = params.action;
				updateWorkerStatus(ctx, snapshot);
				const result = snapshotResult(snapshot, true);
				result.content[0].text = `Manager action failed: ${message}\n\n${result.content[0].text}`;
				return result;
			}
		},
	});
}

/** Register state recovery when the manager lost a delegation identifier after context compaction. */
function registerStatus(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "delegate_status",
		label: "Delegate Status",
		description: "Return the current or most recent supervised worker state without changing it.",
		promptSnippet: "delegate_status: recover the current supervised delegation state",
		parameters: StatusParams,
		exposure: "model-only",
		executionMode: "sequential",
		annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		renderResult(result, { expanded, isPartial }, theme, context) {
			return renderWorkerResult(result as any, expanded, isPartial, theme, context, true);
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = activeJob?.snapshot() ?? lastSnapshot;
			if (!snapshot || (params.jobId && snapshot.jobId !== params.jobId)) {
				return { content: [{ type: "text", text: "No matching supervised worker state is available." }], details: undefined, isError: true };
			}
			updateWorkerStatus(ctx, snapshot);
			return snapshotResult(snapshot);
		},
	});
}

/** Register only in the parent process and clean every live child when the session shuts down. */
export default function taskDispatcher(pi: ExtensionAPI): void {
	if (process.env[WORKER_ENV]) return;
	for (const role of ROLES) registerDelegate(pi, role);
	registerControl(pi);
	registerStatus(pi);
	pi.on("tool_call", (event) => activeJob
		? activeJob.authorizeNestedToolCall(event.parentToolCallId, event.toolName)
		: revokedExecutorDecision(event.parentToolCallId, event.toolName));
	pi.on("session_shutdown", async () => {
		if (activeJob) await activeJob.dispose();
		activeJob = undefined;
		revokedExecutorRoots.clear();
		revokedExecutorGuardSaturated = false;
	});
}
