# pi-task-dispatcher

Supervised mechanical and engineering delegations for Pi.

Each delegation runs in an isolated, in-memory Pi RPC session. After every cohesive tool batch, a worker-side gate stops execution at a safe boundary and returns a bounded state report. The manager can then inspect the result and explicitly continue, revise, compact, checkpoint, cancel, or take over.

## Features

- **Two worker roles:** mechanical execution and broader engineering work.
- **Enforced supervision:** a private parent-child IPC gate calls `ctx.abort()` after persisted tool results; pausing does not depend on the worker following a prompt.
- **Explicit control:** continue, revise, recalculate, compact, checkpoint, cancel, or take over.
- **Resumable context:** continuation uses the same in-memory worker session and completed tool results.
- **Least privilege:** every start selects an exact Pi built-in worker-tool allowlist; delegation tools and unrelated discovered extensions are unavailable to the worker.
- **Model agnostic:** both roles inherit Pi's active model and thinking level unless an explicit role override is configured.
- **Formula-owned budgets:** the manager supplies semantic workload units, while the dispatcher calculates turn and time ceilings from workload, role, and delegated-model limits.
- **Context insight:** boundary reports include worker context usage, compactions, turns, elapsed time, action counts, and recommendations.
- **Recoverable reports:** the complete action ledger and worker text remain in structured tool details; bounded model-facing text retains recent actions plus both the beginning and ending of long reports.
- **Deterministic UI:** tool renderers display task, current activity, elapsed time, context pressure, and terminal success/failure colors. A compact paused-state line appears in Pi's footer.

## Requirements

- Pi 1.0.3 or later
- Node.js 22.19.0 or later
- One active, authenticated Pi model; optional role-specific models must also be available and authenticated

The supervision gate requires the parent Pi process and child Pi CLI to run under Node.js with an inherited IPC channel. The dispatcher fails closed when that boundary cannot be established; it does not fall back to prompt-only supervision. Worker processes disable ordinary extension discovery and load only the generated supervision gate.

## Installation

Install the published package for the current Pi user:

```sh
pi install npm:pi-task-dispatcher
```

## Tools

| Tool | Responsibility |
| --- | --- |
| `delegate_mechanical` | Start a supervised mechanic delegation. |
| `delegate_engineering` | Start a supervised engineer delegation. |
| `delegate_control` | Apply one explicit manager decision to a paused delegation. |
| `delegate_status` | Recover the current or most recent state without changing it. |

Only one live delegation is currently permitted. A terminal delegation may be inspected until a new one replaces it.

## Starting a delegation

Both role tools require:

- `task`: a self-contained objective, scope, constraints, and acceptance checks;
- `tools`: the smallest exact allowlist selected from Pi's built-in tools and active for the main agent;
- `workload`: semantic estimates used by the deterministic budget formula.

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

Isolated workers accept `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls` when the selected tools are also active in the main Pi session. Extension tools are not supported because the child disables extension discovery.

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
- completed, failed, and potentially mutating action counts;
- recent bounded activity labels;
- active elapsed time and turns against calculated budgets;
- context tokens, context window, percentage, and compaction counts;
- a recommended next decision;
- bounded worker text, if any.

The TUI renders the same structured state as a compact block. Expanding the tool result reveals bounded worker text. The complete action ledger and worker text remain in result details for state reconstruction rather than being discarded by display truncation.

When paused, one unindented footer status appears below Pi's primary report. It shows the identity, active elapsed time, last activity, and context as percentage/window—for example, `10.3%/32k context`. The percentage and window both come from that delegation's selected model and live worker-session statistics, not from the main model.

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
  "policy": {
    "absoluteMaxTurns": 96,
    "absoluteMaxSeconds": 7200,
    "pausedLeaseSeconds": 1800,
    "noProgressSeconds": 600
  }
}
```

Configuration is read for every new delegation. By default, both roles inherit the manager's active model and thinking level, so installation assumes no particular provider or model access. A role may optionally override `model` with `"provider/model"`, `thinking`, or both. Policy values are administrative failsafes, not ordinary task budgets.

Version 3 intentionally ignores the version 2 fields `maxTurns`, `timeoutSeconds`, and `checkpointGraceSeconds`. Remove them from local configuration after migration.

## Lifecycle and cleanup

- A parent-operation abort stops the active worker stage.
- A paused lease eventually closes an abandoned worker.
- Session shutdown or extension reload disposes the child and runtime-controlled temporary files.
- Worker process failures reject pending RPC operations and produce a failed state.
- Worker role instructions and the supervision gate exist only in a runtime-controlled temporary directory.
- The worker uses `--no-session`; no worker session file is persisted.

Process separation is not a security sandbox. Worker tools execute with the Pi host's operating-system permissions. Tool availability does not establish task scope or authorization.

## Development checks

```sh
npm run check
npm run test:gate
```

`check` runs static release invariants and deterministic fake-RPC lifecycle and renderer scenarios. The fake child verifies pause/resume, usage deltas, full action-ledger retention, intercepted prompts, missing-boundary failure, fail-closed timeouts, pre-aborted operations, partial argument rendering, stable repeated rendering, and manager-state transitions without a model request.

`test:gate` performs a small live model integration check with the active parent model exported by Pi through `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`, falling back to Pi's configured default when those values are unavailable; it contains no provider or model assumption. Optional `PI_TASK_DISPATCHER_GATE_MODEL` and `PI_TASK_DISPATCHER_GATE_THINKING` overrides are available for explicit test matrices. The probe verifies that the private gate pauses after a read batch and that the same in-memory child can subsequently complete. It requires configured credentials and therefore is not a hermetic unit test.

