/** Deterministic JSONL/IPC worker used only by the dispatcher's lifecycle and proxy tests. */

import { appendFileSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import { readStrictJsonl } from "./strict-jsonl.mjs";

const scenario = process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO ?? "normal";
const markerPath = process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER;
const observationPath = process.env.PI_TASK_DISPATCHER_FAKE_OBSERVATION_MARKER;
let promptCount = 0;
let proxyConfiguration;
const pendingProxyCalls = new Map();

function send(event) {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

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

function textFromResult(result) {
	return (result?.content ?? [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

async function observe(value) {
	if (observationPath) await appendFile(observationPath, `${JSON.stringify(value)}\n`, "utf8");
}

/** Capture responses the parent dispatcher sends over its private IPC channel. */
process.on("message", (message) => {
	if (!message || typeof message !== "object") return;
	if (message.type !== "task_dispatcher_proxy_update" && message.type !== "task_dispatcher_proxy_result") return;
	const pending = pendingProxyCalls.get(message.requestId);
	if (!pending) return;
	if (message.type === "task_dispatcher_proxy_update") {
		pending.updates.push(message.result);
		pending.onUpdate?.(message.result);
		return;
	}
	pendingProxyCalls.delete(message.requestId);
	pending.resolve({ result: message.result, updates: pending.updates });
});

/** Load and inspect the generated proxy configuration without executing its extension source. */
async function loadProxyConfiguration(extensionValues) {
	const proxyPath = extensionValues.find((value) => value?.endsWith("tool-proxies.ts"));
	if (!proxyPath) throw new Error("runtime proxy extension was not loaded");
	const source = await readFile(proxyPath, "utf8");
	const match = source.match(/^const configuration = (.+) as \{ nonce: string; tools: ProxyTool\[\] \};$/m);
	if (!match) throw new Error("runtime proxy extension omitted its serialized configuration");
	const configuration = JSON.parse(match[1]);
	if (!configuration || typeof configuration.nonce !== "string" || !Array.isArray(configuration.tools)) {
		throw new Error("runtime proxy extension configuration is invalid");
	}
	return { configuration, source };
}

/** Send one simulated child proxy request and retain every parent-streamed partial result. */
function proxyCall(toolName, args, requestId, nonce = proxyConfiguration.nonce, onUpdate) {
	return new Promise((resolve, reject) => {
		if (typeof process.send !== "function") {
			reject(new Error("fake worker has no IPC channel"));
			return;
		}
		pendingProxyCalls.set(requestId, { resolve, updates: [], onUpdate });
		process.send({ type: "task_dispatcher_proxy_request", nonce, requestId, toolName, args });
	});
}

/** Emit the worker-visible lifecycle around one proxied manager tool. */
async function emitProxyTool(toolCallId, toolName, args, parentToolCallId) {
	send({ type: "tool_execution_start", toolCallId, toolName, args, ...(parentToolCallId ? { parentToolCallId } : {}) });
	const response = await proxyCall(toolName, args, toolCallId, proxyConfiguration.nonce, (partialResult) => {
		send({ type: "tool_execution_update", toolCallId, toolName, args, partialResult, ...(parentToolCallId ? { parentToolCallId } : {}) });
	});
	send({
		type: "tool_execution_end",
		toolCallId,
		toolName,
		args,
		isError: response.result?.isError === true,
		result: response.result,
		...(parentToolCallId ? { parentToolCallId } : {}),
	});
	return response;
}

function boundaryAndAbort(toolResults = 1) {
	process.send?.({ type: "task_dispatcher_boundary", turnIndex: 0, toolResults });
	send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] } });
	send({ type: "agent_settled" });
}

async function validateFirstPrompt() {
	const toolsIndex = process.argv.indexOf("--tools");
	const selectedTools = toolsIndex >= 0 ? process.argv[toolsIndex + 1]?.split(",") ?? [] : [];
	const extensionValues = process.argv.flatMap((argument, index) => argument === "--extension" ? [process.argv[index + 1]] : []);
	const loaded = await loadProxyConfiguration(extensionValues);
	proxyConfiguration = loaded.configuration;
	const proxyNames = proxyConfiguration.tools.map((tool) => tool.name);
	if (scenario === "normal" && extensionValues.some((value) => value?.endsWith("codemode-only.ts"))) {
		throw new Error("codemode extension was injected without explicit selection");
	}
	if (scenario === "codemode") {
		const nativeCodemodePath = extensionValues.find((value) => value?.endsWith("codemode-only.ts"));
		let nativeCodemodeSource = "";
		try {
			if (nativeCodemodePath) nativeCodemodeSource = await readFile(nativeCodemodePath, "utf8");
		} catch {
			// The deterministic check below reports the source failure.
		}
		if (
			!selectedTools.includes("codemode")
			|| extensionValues.includes("builtin:codemode")
			|| !nativeCodemodePath
			|| !nativeCodemodeSource.includes('createCodemodeExtension({ mode: "only" })')
			|| !nativeCodemodeSource.includes('from "@earendil-works/pi-coding-agent"')
			|| proxyNames.join(",") !== "read"
		) {
			throw new Error("native codemode-only extension or selected proxy visibility was incorrect");
		}
	}
	if (scenario === "extension" && proxyNames.join(",") !== "extension_tool") {
		throw new Error(`extension tool proxy visibility was not exact: ${proxyNames.join(",")}`);
	}
	if (scenario === "transitive" && proxyNames.join(",") !== "extension_tool,read") {
		throw new Error(`transitive tool proxy visibility was not exact: ${proxyNames.join(",")}`);
	}
	if (scenario === "proxy-rich" && proxyNames.join(",") !== "rich_tool") {
		throw new Error(`rich tool proxy visibility was not exact: ${proxyNames.join(",")}`);
	}
	if (!loaded.source.includes("task_dispatcher_proxy_request") || !loaded.source.includes("Type.Unsafe")) {
		throw new Error("runtime proxy extension omitted its IPC or schema bridge");
	}
}

async function runFirstPrompt() {
	if (scenario === "presentation") {
		send({ type: "message_start", message: { role: "assistant" } });
		send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stream delta that must be replaced" } });
		await new Promise((resolve) => setTimeout(resolve, 150));
		send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "stream block that must be replaced" } });
		send({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "authoritative first assistant message" }], usage: usage(10, 2) },
		});
		await emitProxyTool("fake-presentation-read", "read", { path: "presentation.txt" });
		boundaryAndAbort();
		return;
	}
	if (scenario === "length") {
		send({
			type: "message_end",
			message: { role: "assistant", stopReason: "length", content: [{ type: "text", text: "truncated worker report" }], usage: usage(7, 4) },
		});
		send({ type: "agent_settled" });
		return;
	}
	if (scenario === "security") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		const cross = await proxyCall("read", { path: "cross-job.txt" }, "security-cross-job", "wrong-job-nonce");
		const unknown = await proxyCall("not_selected", {}, "security-unknown");
		const first = await proxyCall("read", { path: "once.txt" }, "security-replay");
		const replay = await proxyCall("read", { path: "twice.txt" }, "security-replay");
		await observe({
			kind: "security-active",
			cross: textFromResult(cross.result),
			unknown: textFromResult(unknown.result),
			first: textFromResult(first.result),
			replay: textFromResult(replay.result),
		});
		boundaryAndAbort();
		setTimeout(() => {
			void proxyCall("read", { path: "paused.txt" }, "security-paused")
				.then((paused) => observe({ kind: "security-paused", text: textFromResult(paused.result) }))
				.catch((error) => observe({ kind: "security-paused", text: String(error) }));
		}, 40);
		return;
	}
	if (scenario === "concurrent") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		await Promise.all([
			emitProxyTool("fake-concurrent-read", "read", { path: "first.txt" }),
			emitProxyTool("fake-concurrent-extension", "extension_tool", { action: "second" }),
		]);
		boundaryAndAbort(2);
		return;
	}
	if (scenario === "cancel-proxy") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		await emitProxyTool("fake-cancel-read", "read", { path: "wait-for-abort.txt" });
		boundaryAndAbort();
		return;
	}
	if (scenario === "identity-race") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		await observe({ kind: "identity-race-ready" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		await emitProxyTool("fake-identity-race-read", "read", { path: "identity-race.txt" });
		boundaryAndAbort();
		return;
	}
	if (scenario === "child-exit") {
		process.exit(17);
		return;
	}
	if (scenario === "extension" || scenario === "transitive") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		await emitProxyTool("fake-extension-1", "extension_tool", { action: "delegated" });
		boundaryAndAbort();
		return;
	}
	if (scenario === "proxy-rich") {
		send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
		const response = await emitProxyTool("fake-rich-1", "rich_tool", { value: "rich" });
		await observe({
			kind: "rich",
			updates: response.updates.length,
			hasImage: response.result?.content?.some((part) => part?.type === "image") === true,
			structuredContent: response.result?.structuredContent,
			isError: response.result?.isError === true,
			terminate: response.result?.terminate === true,
			hasUsage: Object.prototype.hasOwnProperty.call(response.result ?? {}, "usage"),
		});
		boundaryAndAbort();
		return;
	}

	send({ type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) } });
	if (scenario === "codemode") {
		send({ type: "tool_execution_start", toolCallId: "fake-codemode-1", toolName: "codemode", args: "return image" });
		await emitProxyTool("fake-read-nested", "read", { path: "reference.png" }, "fake-codemode-1");
		send({
			type: "tool_execution_end",
			toolCallId: "fake-codemode-1",
			toolName: "codemode",
			isError: false,
			result: {
				content: [
					{ type: "text", text: "generated image retained in runtime temporary storage" },
					{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
				],
				usage: usage(7, 3),
			},
		});
	} else {
		await emitProxyTool("fake-read-1", "read", { path: "package.json" });
	}
	if (scenario === "missing-boundary") {
		send({
			type: "message_end",
			message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "unsafe final response after tool" }], usage: usage(2, 2) },
		});
	} else {
		boundaryAndAbort();
	}
	if (scenario === "missing-boundary") send({ type: "agent_settled" });
}

async function runContinuation() {
	if (scenario === "presentation") {
		const longReport = [
			"presentation opening",
			"A".repeat(2_600),
			"MIDDLE-ONLY-IN-EXPANDED-PRESENTATION",
			"B".repeat(4_000),
			"latest-presentation-marker",
		].join("\n");
		send({ type: "message_start", message: { role: "assistant" } });
		send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
		send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "partial final assistant text" } });
		send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "replaced final assistant text" } });
		send({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: longReport }], usage: usage(5, 3) } });
		send({ type: "agent_settled" });
		return;
	}
	send({
		type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "deterministic worker complete" }], usage: usage(5, 3) },
	});
	send({ type: "agent_settled" });
}

process.on("SIGTERM", () => {
	if (observationPath) appendFileSync(observationPath, `${JSON.stringify({ kind: "signal", signal: "SIGTERM" })}\n`, "utf8");
	process.exit(0);
});

// Expose the disposable test process identity because Windows terminates it without delivering SIGTERM.
await observe({ kind: "worker-start", pid: process.pid });

// Keep strict LF-framed RPC command handling separate from private bidirectional IPC.
await readStrictJsonl(process.stdin, async (line) => {
	if (!line.trim()) return;
	const command = JSON.parse(line);
	if (command.type === "set_auto_compaction") {
		send({ type: "response", id: command.id, command: command.type, success: true });
		return;
	}
	if (command.type === "get_session_stats") {
		if (scenario === "stats-timeout") return;
		send({
			type: "response",
			id: command.id,
			command: command.type,
			success: true,
			data: { contextUsage: { tokens: 100 + promptCount, contextWindow: 1000, percent: 10 + promptCount } },
		});
		return;
	}
	if (command.type === "compact") {
		send({ type: "response", id: command.id, command: command.type, success: false, error: "Nothing to compact (fake session)" });
		return;
	}
	if (command.type !== "prompt") return;

	promptCount++;
	if (markerPath) await appendFile(markerPath, `${promptCount}\n`, "utf8");
	if (scenario === "timeout") return;
	if (scenario === "handled") {
		send({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "handled" } });
		return;
	}
	if (promptCount === 1) {
		try {
			await validateFirstPrompt();
		} catch (error) {
			send({ type: "response", id: command.id, command: command.type, success: false, error: error instanceof Error ? error.message : String(error) });
			return;
		}
	}
	send({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "started" } });
	if (promptCount === 1) await runFirstPrompt();
	else await runContinuation();
});
