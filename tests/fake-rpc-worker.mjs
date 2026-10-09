/** Deterministic JSONL/IPC worker used only by the dispatcher's lifecycle tests. */

import { appendFile, readFile } from "node:fs/promises";
import { readStrictJsonl } from "./strict-jsonl.mjs";

const scenario = process.env.PI_TASK_DISPATCHER_FAKE_SCENARIO ?? "normal";
const markerPath = process.env.PI_TASK_DISPATCHER_FAKE_PROMPT_MARKER;
let promptCount = 0;

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

// Process strict LF-framed RPC commands in order, including asynchronous scenario handlers.
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
		const toolsIndex = process.argv.indexOf("--tools");
		const selectedTools = toolsIndex >= 0 ? process.argv[toolsIndex + 1]?.split(",") ?? [] : [];
		const extensionValues = process.argv.flatMap((argument, index) => argument === "--extension" ? [process.argv[index + 1]] : []);
		if (scenario === "normal" && extensionValues.some((value) => value?.endsWith("codemode-only.ts"))) {
			send({ type: "response", id: command.id, command: command.type, success: false, error: "codemode extension was injected without explicit selection" });
			return;
		}
		if (scenario === "codemode") {
			const nativeCodemodePath = extensionValues.find((value) => value?.endsWith("codemode-only.ts"));
			let nativeCodemodeSource = "";
			try {
				if (nativeCodemodePath) nativeCodemodeSource = await readFile(nativeCodemodePath, "utf8");
			} catch {
				// The failed source check below reports a deterministic fake-RPC error.
			}
			if (
				!selectedTools.includes("codemode")
				|| extensionValues.includes("builtin:codemode")
				|| !nativeCodemodePath
				|| !nativeCodemodeSource.includes('createCodemodeExtension({ mode: "only" })')
				|| !nativeCodemodeSource.includes('from "@earendil-works/pi-coding-agent"')
			) {
				send({ type: "response", id: command.id, command: command.type, success: false, error: "native codemode-only extension was not isolated and loaded" });
				return;
			}
		}
	}

	send({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "started" } });
	if (scenario === "presentation") {
		if (promptCount === 1) {
			send({ type: "message_start", message: { role: "assistant" } });
			send({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
			send({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "stream delta that must be replaced" } });
			// Keep the fake stream active long enough to exercise the dispatcher's coalesced live update.
			await new Promise((resolve) => setTimeout(resolve, 150));
			send({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "stream block that must be replaced" } });
			send({
				type: "message_end",
				message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "authoritative first assistant message" }], usage: usage(10, 2) },
			});
			send({ type: "tool_execution_start", toolCallId: "fake-presentation-read", toolName: "read", args: { path: "presentation.txt" } });
			send({
				type: "tool_execution_update",
				toolCallId: "fake-presentation-read",
				toolName: "read",
				args: { path: "presentation.txt" },
				partialResult: { content: [{ type: "text", text: "partial read result that must be replaced" }] },
			});
			// Keep the partial tool result observable before the authoritative result replaces it.
			await new Promise((resolve) => setTimeout(resolve, 150));
			send({
				type: "tool_execution_end",
				toolCallId: "fake-presentation-read",
				toolName: "read",
				isError: false,
				result: {
					content: [{ type: "text", text: "final read result one\nfinal read result two\nfinal read result three\nfinal read result four\nfinal read result five\nfinal read result six \u001b[31mred\u001b[0m" }],
					usage: usage(3, 1),
				},
			});
			process.send?.({ type: "task_dispatcher_boundary", turnIndex: 0, toolResults: 1 });
			send({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] } });
			send({ type: "agent_settled" });
			return;
		}
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
		send({
			type: "message_end",
		message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: longReport }], usage: usage(5, 3) },
		});
		send({ type: "agent_settled" });
		return;
	}
	if (scenario === "length" && promptCount === 1) {
		send({
			type: "message_end",
			message: {
				role: "assistant",
				stopReason: "length",
				content: [{ type: "text", text: "truncated worker report" }],
				usage: usage(7, 4),
			},
		});
		send({ type: "agent_settled" });
		return;
	}
	if (promptCount === 1) {
		send({
			type: "message_end",
			message: { role: "assistant", stopReason: "toolUse", content: [], usage: usage(10, 2) },
		});
		if (scenario === "codemode") {
			send({ type: "tool_execution_start", toolCallId: "fake-codemode-1", toolName: "codemode", args: "return image" });
			send({ type: "tool_execution_start", toolCallId: "fake-read-nested", parentToolCallId: "fake-codemode-1", toolName: "read", args: { path: "reference.png" } });
			send({ type: "tool_execution_end", toolCallId: "fake-read-nested", parentToolCallId: "fake-codemode-1", toolName: "read", isError: false, result: { usage: usage(3, 1) } });
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
			send({ type: "tool_execution_start", toolCallId: "fake-read-1", toolName: "read", args: { path: "package.json" } });
			send({ type: "tool_execution_end", toolCallId: "fake-read-1", toolName: "read", isError: false, result: { usage: usage(3, 1) } });
		}
		if (scenario === "missing-boundary") {
			send({
				type: "message_end",
				message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "unsafe final response after tool" }], usage: usage(2, 2) },
			});
		} else {
			process.send?.({ type: "task_dispatcher_boundary", turnIndex: 0, toolResults: 1 });
			send({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted", content: [] },
			});
		}
		send({ type: "agent_settled" });
		return;
	}

	send({
		type: "message_end",
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "deterministic worker complete" }],
			usage: usage(5, 3),
		},
	});
	send({ type: "agent_settled" });
});
