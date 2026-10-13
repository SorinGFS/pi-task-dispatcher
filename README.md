# pi-task-dispatcher

Supervised mechanical, assistant, engineering, and media-design delegations for Pi.

Each delegation runs in an isolated, in-memory Pi RPC session. After every cohesive tool batch, a worker-side gate stops execution at a safe boundary and returns a bounded state report. The manager can then inspect the result and explicitly continue, revise, compact, checkpoint, cancel, or take over.

## Features

- **Four worker roles:** prescribed mechanical execution, fallback assistant work, broader engineering, and media design.
- **Enforced supervision:** a private parent-child IPC gate calls `ctx.abort()` after persisted tool results; pausing does not depend on the worker following a prompt.
- **Explicit control:** continue, revise, recalculate, compact, checkpoint, cancel, or take over.
- **Resumable context:** continuation uses the same in-memory worker session and completed tool results.
- **Manager-granted capabilities:** every start snapshots exact selected tools from the manager's current capabilities. Every selected non-`codemode` tool must be callable through `ctx.tools`/`ctx.executeTool()` and becomes a nonce-bound child proxy back to that manager path; unselected, recursive, replayed, cross-job, and paused requests fail closed. Active `codemode` is the deliberate exception: when explicitly selected, a runtime-temporary extension loads Pi's public native factory in `only` mode, and it is never injected otherwise.
- **Model agnostic:** every role inherits Pi's active model and thinking level unless an explicit role override is configured.
- **Formula-owned budgets:** the manager supplies semantic workload units, while the dispatcher calculates turn and time ceilings from workload, role, and delegated-model limits.
- **Context insight:** boundary reports include worker context usage, compactions, turns, elapsed time, action counts, and recommendations.
- **Recoverable reports:** the complete action ledger and worker text remain in structured tool details; bounded model-facing text retains recent actions plus both the beginning and ending of long reports.
- **Deterministic UI:** tool renderers display task, current activity, elapsed time, context pressure, and terminal success/failure colors. Pi's footer retains the latest state of every role invoked in the session.

## Requirements

- Pi 1.1.0 or later
- Node.js 22.19.0 or later
- One active, authenticated Pi model; optional role-specific models must also be available and authenticated

The supervision gate and manager-tool proxies require the parent Pi process and child Pi CLI to run under Node.js with an inherited IPC channel. The dispatcher fails closed when that boundary cannot be established; it does not fall back to prompt-only supervision or direct child access to manager capabilities. Worker processes disable ordinary extension discovery and load a generated proxy extension, the generated supervision gate, and a generated native codemode-only extension only when that tool was explicitly selected.

## Installation

Install the published package for the current Pi user:

```sh
pi install npm:pi-task-dispatcher
```

## Tools

| Tool | Responsibility |
| --- | --- |
| `delegate_mechanical` | Execute prescribed work whose method and expected result are already known. |
| `delegate_assistant` | Perform the user-requested work when no other worker role applies; the orchestrator does not perform that work directly. |
| `delegate_engineering` | Investigate or implement uncertain, cross-component, or technically intensive work. |
| `delegate_designer` | Create or edit image assets and process image, video, or audio files with available tools. |
| `delegate_control` | Apply one explicit manager decision to a paused delegation. |
| `delegate_status` | Recover the current or most recent state without changing it. |

Only one live delegation is currently permitted. A terminal delegation may be inspected until a new one replaces it.

## Choosing a role

| Role | Selection rule |
| --- | --- |
| Mechanic | The method and expected result are known; execute exact steps. |
| Assistant | When no other worker role applies, use `delegate_assistant` for the user-requested work instead of having the orchestrator perform it directly. |
| Engineer | The cause, design, or implementation path is uncertain or spans components. |
| Designer | The requested result is an image, video, audio, or related media asset or transformation. |

The orchestrator retains responsibility for delegation decisions, worker supervision, integration of delegated results, and the final response.

The designer can inspect images with `read`, use image models through `codemode`, and run explicitly selected command-line media programs through `bash` or `powershell`. Generated codemode images are runtime-temporary until the worker deliberately copies a selected output to the requested workspace destination and verifies it. Video and audio generation depends on explicitly available command-line programs or services; editing workflows can use programs such as `ffmpeg` when installed.

## Starting a delegation

Every role tool requires:

- `task`: a self-contained objective, scope, constraints, and acceptance checks;
- `tools`: the smallest exact capability grant selected from tools callable in the current manager context; this can include compatible extension-defined tools, but cannot include delegation tools or names unavailable through `ctx.executeTool()`—except active `codemode`, which is recreated child-locally;
- `workload`: semantic estimates used by the deterministic budget formula.

When `codemode` is active and delegated work materially benefits from JavaScript orchestration, batched/parallel/filtering of selected tools, or classifier/image models, include it in the delegated capability grant rather than reserving it for the manager. Also include each selected tool its script must call through the child proxy; otherwise omit `codemode`.

```json
{
  "task": "Inspect the parser cache, correct its invalidation, and run the focused tests.",
  "tools": ["read", "edit", "bash"],
  "workload": {
    "investigationUnits": 3,
    "changeUnits": 2,
    "verificationUnits": 2,
    "expectedLongRunningSeconds": 60
  }
}
```

A workload unit is intentionally semantic:

- `investigationUnits`: cohesive components or evidence groups to inspect;
- `changeUnits`: related edit groups;
- `verificationUnits`: focused check or test groups;
- `expectedLongRunningSeconds`: additional expected command time.

At least one investigation, change, or verification unit is required.

The worker receives exactly the selected capability names: manager-callable tools plus active `codemode` when requested. For every selected name except `codemode`, a generated child extension recreates the public tool metadata and sends execution through a private nonce-bound IPC proxy to the manager's `ctx.executeTool()` path, so manager validation, hooks, policy, and nested usage accounting remain authoritative. Calls that a selected manager tool makes transitively are blocked unless their names are also in the same grant. Proxy manifests, individual arguments/results, concurrent requests, and total per-job requests have fixed limits and fail closed when exceeded. The proxy grant is rebuilt and definition-fingerprinted before continuation; a changed or unavailable callable tool hard-stops the job rather than weakening the original grant. If `codemode` is selected, the child additionally generates a temporary extension using Pi's public `createCodemodeExtension({ mode: "only" })` API while ordinary extension discovery remains disabled. This makes `codemode` model-visible; its scripts can call only selected proxied tools and the non-LLM model catalog. Unrelated manager extensions and delegation tools remain unavailable.

Pi 1.2's `reachesTools` metadata exposes only the job's exact fixed grant for a start and its matching paused `continue` or `revise` control. The callback stays parent-local and is never copied into the JSON proxy manifest.

The current formula derives planned work turns from those units, applies a role factor and a bounded scale based on the selected delegated model's own context window, reserves two additional turns for synthesis or recovery, then derives active execution time from calculated turns plus expected long-running time. Administrative ceilings always win. Formula inputs and results are returned in every state report so they can be reviewed and recalculated. Time spent paused for manager deliberation does not consume the active execution budget.

## Safe action boundaries

A worker run proceeds as follows:

1. Pi produces one assistant response.
2. Its complete tool-call batch runs and tool results are persisted.
3. The worker-only gate reports the boundary through private IPC.
4. The gate aborts the automatic next worker turn.
5. The RPC run settles while the child process and in-memory context remain alive.
6. The delegation tool returns the new state to the manager.

An action batch can contain parallel tool calls from one worker response. Already-running tools are allowed to finish. The boundary prevents another productive model turn from starting without a manager decision.

A tool-free response that reaches the model's output limit is retained as a recoverable paused state. Continuing resumes the same in-memory session so the worker can finish its truncated report; the dispatcher does not misreport that response as completed.

## Controlling a paused delegation

`delegate_control` accepts these actions:

| Action | Effect |
| --- | --- |
| `continue` | Resume from completed results. `actionBatches` may lease 1–10 batches before returning. |
| `revise` | Add controlling instructions, then resume. |
| `recalculate` | Supply remaining semantic workload and extend the current ceilings from observed turns and active execution time without running the worker. |
| `compact` | Compact the idle worker's own context and return refreshed state. |
| `take_over` | Stop the delegation externally and transfer remaining work to the manager. |
| `checkpoint` | Stop externally and preserve a synthetic checkpoint from observed state. |
| `cancel` | Stop externally and close the job. |

Example:

```json
{
  "jobId": "engineer-2",
  "action": "continue",
  "actionBatches": 2
}
```

The dispatcher enforces takeover, cancellation, budget exhaustion, no-progress policy, and process cleanup. These actions do not depend on worker cooperation.

## State reports and screen output

A paused result contains:

- a session-local sequential identity such as `engineer-2`, plus role, model, and status;
- the delegated task and live command or tool activity while execution is running;
- boundary sequence and current phase;
- completed, failed, and potentially mutating action counts, where only an explicit tool `annotations.readOnlyHint: true` is classified as non-mutating;
- recent bounded activity labels in completion order and image-output MIME/size metadata without retained base64 payloads;
- active elapsed time and turns against calculated budgets;
- context tokens, context window, percentage, and compaction counts;
- a recommended next decision;
- bounded model-facing worker text, if any;
- a complete sanitized live presentation ledger in structured result details, including streamed assistant text and child-tool lifecycle/output placeholders without image base64.

The TUI renders the same structured state as a compact block plus the latest five visual rows of the presentation ledger. When older rows are omitted, Pi's native tool-expansion key hint appears; expanding the tool result reveals the complete captured presentation text, not the 5,000-character model-facing worker-text preview. The complete action ledger, presentation ledger, and worker text remain in result details for state reconstruction rather than being discarded by display truncation.

After the first worker state, one unindented, dim footer status remains below Pi's primary report and updates across worker lifecycle states. It retains the newest state observed for every invoked role, with the most recently updated role first and each entry ordered as identity, context, model, and thinking—for example, `engineer-2 · 10.3%/32k • model-name • medium | mechanic-1 · 8.1%/128k • smaller-model • low`. Each percentage and window comes from that delegation's own fresh worker session; a continuation accumulates context in the same job, while a new delegation starts a new context. Current or latest action details appear in the delegation or manager block rather than the footer.

## Worker compaction

The dispatcher explicitly enables automatic compaction in every worker session. Pi's automatic compaction remains the overflow safety mechanism.

The dispatcher also:

- observes compaction lifecycle events;
- accounts for reported compaction usage;
- queries `get_session_stats` at safe boundaries;
- recommends proactive compaction when context usage reaches the current policy threshold;
- permits explicit worker compaction only while paused.

Worker compaction is independent from compaction of the main Pi conversation.

## Configuration

The optional configuration file is `task-dispatcher.json` in Pi's agent directory.

```json
{
  "mechanic": {
    "model": "provider/mechanic-model",
    "thinking": "high"
  },
  "assistant": {
    "model": "provider/assistant-model",
    "thinking": "low"
  },
  "engineer": {
    "model": "provider/engineer-model",
    "thinking": "high"
  },
  "designer": {
    "model": "provider/vision-model",
    "thinking": "medium"
  },
  "policy": {
    "absoluteMaxTurns": 96,
    "absoluteMaxSeconds": 7200,
    "pausedLeaseSeconds": 1800,
    "noProgressSeconds": 600
  }
}
```

Configuration is read for every new delegation. By default, all roles inherit the manager's active model and thinking level, so installation assumes no particular provider or model access. Each role may optionally override `model` with `"provider/model"`, `thinking`, or both. Policy values are administrative failsafes, not ordinary task budgets.

Version 3 intentionally ignores the version 2 fields `maxTurns`, `timeoutSeconds`, and `checkpointGraceSeconds`. Remove them from local configuration after migration.

## Lifecycle and cleanup

- A parent-operation abort stops the active worker stage.
- A paused lease eventually closes an abandoned worker.
- Session shutdown or extension reload disposes the child and runtime-controlled temporary files.
- Worker process failures reject pending RPC operations and revoke every in-flight manager proxy execution.
- A manager executor lease exists only while `delegate_*` start or `delegate_control` continuation is running; returning paused or terminal state aborts remaining proxied executions.
- Worker role instructions, the tool-proxy extension, and the supervision gate exist only in a runtime-controlled temporary directory.
- The selected native codemode-only extension may create runtime-temporary image outputs; the designer must persist requested outputs explicitly before completion.
- The worker uses `--no-session`; no worker session file is persisted.

Process separation is not a security sandbox. Worker tools execute with the Pi host's operating-system permissions. Tool availability does not establish task scope or authorization.

## Development checks

```sh
npm run check
npm run test:gate
```

`check` runs static release invariants and deterministic fake-RPC lifecycle and renderer scenarios. The fake child verifies exact manager capability grants, extension-defined tools, built-in-name manager overrides, transitive-call confinement, codemode-only loading, proxy streaming/results/usage stripping, images and structured content, concurrent manager execution, nonce/name/replay/paused-request rejection, continuation revalidation, cancellation, child-exit/session-shutdown cleanup, pause/resume, output-limit recovery, presentation compaction, and existing fail-closed lifecycle paths without a model request.

`test:gate` loads the release extension and performs a small live model integration check with the active parent model exported by Pi through `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`, falling back to the first available model listed by Pi when those values are unavailable; it contains no provider assumption. Optional `PI_TASK_DISPATCHER_GATE_MODEL` and `PI_TASK_DISPATCHER_GATE_THINKING` overrides are available for explicit test matrices. The probe verifies generated native codemode-only loading, a codemode script calling `read` through the manager proxy exactly once, a private pause after that completed batch, and subsequent completion in the same in-memory child. It requires configured credentials and therefore is not a hermetic unit test.

