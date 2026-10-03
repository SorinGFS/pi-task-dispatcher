# pi-task-dispatcher

Delegate bounded mechanical and engineering subtasks to configurable Pi worker models without replacing the model selected for the main Pi session.

## How it works

Your selected Pi model remains the **orchestrator**: it decides whether to delegate, supplies a self-contained task, evaluates the worker report, reviews material changes, and owns the final answer. This package adds two model-only tools:

| Tool | Use it when |
| --- | --- |
| `delegate_mechanical` | The outcome and constraints are precise and the work is bounded, multi-step, and primarily inspection, exact edits, repetitive transformation, commands, retrieval, or verification. Use a direct tool for a single trivial operation. |
| `delegate_engineering` | A self-contained engineering subtask needs investigation, implementation, debugging, refactoring, testing, review, research, or analysis. Include the outcome, constraints, and acceptance conditions. |

Both workers operate in the current workspace and can modify files when their configured tools permit it.

After the orchestrator selects a delegation tool, its role is routed deterministically to that role's configured `provider/model`. That routing does **not** make a worker's output, changes, or correctness deterministic; treat every worker report as input to review and verification.

## Requirements

- Pi 1.0.0 or later
- Node.js 22.19.0 or later
- A configured, authenticated Pi model for each worker role you invoke

## Install

Install the published package for your Pi user configuration:

```sh
pi install npm:pi-task-dispatcher@1.0.0
```

For a local checkout, run this from its parent directory:

```sh
pi install ./pi-task-dispatcher
```

To register either source in the current project's `.pi/settings.json` instead, add `--local`:

```sh
pi install npm:pi-task-dispatcher@1.0.0 --local
```

Project packages load only after that project is trusted. In an already running Pi session, run:

```text
/reload
```

`/reload` reloads extensions and other discovered resources. The worker configuration below is read again for every delegation.

## Default workers

| Role | Model | Thinking | Timeout | Turn limit |
| --- | --- | --- | ---: | ---: |
| Mechanic | `openai-codex/gpt-5.6-luna` | `max` | 300 seconds | 20 |
| Engineer | `openai-codex/gpt-5.6-terra` | `max` | 900 seconds | 30 |

By default, both workers receive this explicit tool allowlist:

```text
read,bash,edit,write
```

`pi-task-dispatcher` provides only these four native Pi tools by default; it does not provide `web_search`, `fetch_content`, `get_search_content`, or `source_check`. If you have the separate `pi-web-access` package installed, you may explicitly add those tools to a role's `tools` array:

```json
{
  "mechanic": {
    "tools": ["read", "bash", "edit", "write", "web_search", "fetch_content", "get_search_content", "source_check"]
  }
}
```

## Configure workers

Optionally create `~/.pi/agent/task-dispatcher.json`. If Pi's agent directory is overridden, use `<agent-dir>/task-dispatcher.json` instead. Missing role objects and fields inherit the defaults.

This is a complete valid configuration using the defaults:

```json
{
  "version": 1,
  "mechanic": {
    "model": "openai-codex/gpt-5.6-luna",
    "thinking": "max",
    "tools": [
      "read",
      "bash",
      "edit",
      "write"
    ],
    "timeoutSeconds": 300,
    "maxTurns": 20
  },
  "engineer": {
    "model": "openai-codex/gpt-5.6-terra",
    "thinking": "max",
    "tools": [
      "read",
      "bash",
      "edit",
      "write"
    ],
    "timeoutSeconds": 900,
    "maxTurns": 30
  }
}
```

| Field | Meaning |
| --- | --- |
| `version` | Optional. When present, it must be `1`. |
| `mechanic`, `engineer` | Optional per-role objects. Each supplied field overrides that role's default. |
| `model` | A `provider/model` string. Pi verifies that the exact model exists in its registry and has usable authentication before starting the worker. |
| `thinking` | One of `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | A non-empty array of tool names. It replaces, rather than extends, the default allowlist; duplicate names are removed. |
| `timeoutSeconds` | Positive integer wall-clock limit for the worker process. |
| `maxTurns` | Positive integer limit for a continuing tool-using worker loop. |

## Isolation, limits, and safety

Each delegation starts a separate, no-session Pi child process in the current workspace. The worker receives its role prompt, selected model, thinking level, and only the configured `tools` allowlist. The dispatcher does not register either delegation tool inside worker processes, so workers cannot recursively delegate through this package.

The parent cancellation signal is propagated to the child. Workers are stopped on timeout, and an ongoing tool-using loop is stopped at its configured turn limit. While a worker runs, its tool activity can be reported as progress. Its final tool result includes the role, model, thinking level, configured tool names, status, turns, duration, exit information, activity, and aggregated usage; non-completed runs are returned as errors with a diagnostic and any available partial report. Reported failure states include configuration, model, and process errors, cancellation, timeout, turn-limit, and incomplete outcomes.

> **Security warning:** Worker process isolation is not a security sandbox. A worker can use every tool in its configured allowlist with the Pi host's permissions in the current environment. Use the smallest practical allowlist and delegate only work you are prepared to authorize.

## Short workflow

1. Select the normal Pi model that should orchestrate the task.
2. Give it a bounded request, for example: “Use `delegate_engineering` to diagnose the failing parser test. Do not change public APIs; run the focused test; return the cause, files changed, and test result.”
3. The orchestrator calls the selected worker tool, receives its report, inspects relevant changes and verification, then produces the final response.
