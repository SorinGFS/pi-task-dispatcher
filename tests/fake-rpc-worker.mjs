/** Deterministic JSONL/IPC worker used only by the dispatcher's lifecycle tests. */

import { appendFile } from "node:fs/promises";
import readline from "node:readline";

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

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
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

	if (scenario === "codemode" && promptCount === 1) {
		const toolsIndex = process.argv.indexOf("--tools");
		const selectedTools = toolsIndex >= 0 ? process.argv[toolsIndex + 1]?.split(",") ?? [] : [];
		const extensionValues = process.argv.flatMap((argument, index) => argument === "--extension" ? [process.argv[index + 1]] : []);
		if (!selectedTools.includes("codemode") || !extensionValues.includes("builtin:codemode")) {
			send({ type: "response", id: command.id, command: command.type, success: false, error: "codemode was not isolated and loaded" });
			return;
		}
	}

	send({ type: "response", id: command.id, command: command.type, success: true, data: { disposition: "started" } });
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
