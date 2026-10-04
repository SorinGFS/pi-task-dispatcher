# pi-task-dispatcher

Delegate bounded tasks from a Pi session to dedicated mechanical and engineering worker models while the selected main model remains in control.

## Features

- **Two focused worker roles:** route precise execution work to a mechanic model and broader implementation work to an engineer model.
- **Least-privilege delegation:** every call supplies an exact tool allowlist selected from tools active for the main agent. Workers cannot invoke the delegation tools recursively.
- **Live progress:** streamed worker text, tool activity, and an elapsed-time heartbeat keep long-running tasks visible.
- **Recoverable interruption:** approaching time and turn limits request a worker-authored checkpoint. A hard timeout returns a synthetic fallback checkpoint.
- **Explicit continuation:** a checkpoint never starts another worker automatically. The main agent reviews current state and decides what happens next.

## Worker tools

The package adds two model-only tools to Pi:

| Tool | Intended use |
| --- | --- |
| `delegate_mechanical` | Bounded multi-step inspection, exact edits, repetitive transformations, commands, retrieval, or verification with precise acceptance conditions. |
| `delegate_engineering` | Self-contained investigation, implementation, debugging, refactoring, testing, review, research, or analysis. |

The main model remains the **orchestrator**. It defines the delegated task, selects the smallest sufficient tool allowlist, evaluates the report, reviews material changes, performs required verification, and owns the final answer.

Workers operate in the current workspace and can modify files only when their selected tools permit it. Role routing to the configured `provider/model` is deterministic; worker output and correctness are not. Treat every worker report as input to review rather than proof of completion.

## Requirements

- Pi 1.0.2 or later
- Node.js 22.19.0 or later
- A configured and authenticated Pi model for each worker role you use

## Installation

Install the package for your Pi user configuration:

```sh
pi install npm:pi-task-dispatcher
```

To install it only for the current project, add `--local`:

```sh
pi install npm:pi-task-dispatcher --local
```

Project packages load only after the project is trusted. In an active Pi session, load the extension with:

```text
/reload
```

## Configuration

The package works without a configuration file using these defaults:

| Role | Model | Thinking | Hard timeout | Checkpoint grace | Turn limit |
| --- | --- | --- | ---: | ---: | ---: |
| Mechanic | `openai-codex/gpt-5.6-luna` | `max` | 300 seconds | 30 seconds | 20 |
| Engineer | `openai-codex/gpt-5.6-terra` | `max` | 900 seconds | 45 seconds | 30 |

To override them, create `~/.pi/agent/task-dispatcher.json`. If Pi uses a custom agent directory, create `task-dispatcher.json` in that directory instead. Missing roles and fields retain their defaults.

```json
{
  "mechanic": {
    "model": "openai-codex/gpt-5.6-luna",
    "thinking": "max",
    "timeoutSeconds": 300,
    "checkpointGraceSeconds": 30,
    "maxTurns": 20
  },
  "engineer": {
    "model": "openai-codex/gpt-5.6-terra",
    "thinking": "max",
    "timeoutSeconds": 900,
    "checkpointGraceSeconds": 45,
    "maxTurns": 30
  }
}
```

| Field | Description |
| --- | --- |
| `mechanic`, `engineer` | Optional role objects. Each supplied field overrides that role's default. |
| `model` | Exact `provider/model` identity. The dispatcher verifies model availability and authentication before starting a worker. |
| `thinking` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `timeoutSeconds` | Positive integer hard wall-clock limit for the worker process. |
| `checkpointGraceSeconds` | Positive integer period reserved before the hard timeout for a graceful checkpoint. It must be less than `timeoutSeconds`. |
| `maxTurns` | Positive integer work-turn limit. The dispatcher allows a final checkpoint response after the limit is reached. |

Configuration is read for every delegation, so configuration-only changes do not require `/reload`.

Tool access is deliberately absent from role configuration. Every delegation selects its own exact allowlist from the main agent's currently active tools; `[]` gives the worker no tools. A continuation must select its tools again and does not inherit the previous allowlist.

## Usage

Give the main model a bounded objective and let it choose whether delegation is useful. For example:

> Use the engineering worker to diagnose the failing parser test. Do not change public APIs. Run the focused test and report the cause, changed files, and test result.

For tighter control, name the role and allowed tools:

> Delegate this to the mechanic worker with only `read` and `bash`: inspect the generated manifest, run its validation command, and report exact mismatches. Do not modify files.

A direct tool remains preferable for one trivial operation. Delegation is most useful when a self-contained episode would otherwise consume multiple agent turns or produce bulky intermediate output.

## Limits and checkpoints

Each delegation runs in a separate Pi RPC child process with an in-memory, no-session conversation. The worker receives its role prompt, selected model, thinking level, and only the allowlist chosen for that call.

The dispatcher propagates parent cancellation and reports live text and tool activity. Before the hard timeout, it steers the worker to stop at the next safe turn boundary and produce a checkpoint. Reaching the turn limit uses the same checkpoint flow. If the worker cannot settle before the hard deadline, the dispatcher terminates it and reports observed completed and interrupted activity in a fallback checkpoint.

Non-completed results include the stopping reason, available partial worker text, observed activity, and a warning when filesystem effects may remain. The main agent then chooses whether to:

- inspect and continue directly;
- delegate a bounded continuation with a newly selected allowlist;
- request user input; or
- stop and report a limitation.

Continuation is never automatic.

## Security

Worker process separation is **not** a security sandbox. A worker uses its selected tools with the Pi host's permissions in the current environment. Tool availability does not establish task scope, authorization, or safety. Use the smallest practical allowlist and delegate only work you are prepared to authorize and review.
