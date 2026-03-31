# pi duet extension

A pi extension for orchestrating two persistent model sessions that plan and implement in alternating review loops. Supports planning from scratch, importing existing plans with optional gap analysis, execution with live streaming, operator steering, and full run lifecycle management.

## Installation

### From GitHub (recommended)

```bash
pi install https://github.com/HenryDeGrasse/pi-codechecking
```

This installs the extension globally. Restart pi or run `/reload` to activate.

### Project-local install

To scope the extension to a single project:

```bash
pi install https://github.com/HenryDeGrasse/pi-codechecking -l
```

### From a local clone

```bash
git clone https://github.com/HenryDeGrasse/pi-codechecking.git
cd pi-codechecking
npm install
pi install .
```

### Run without installing

```bash
pi --no-extensions -e ./extensions/duet/index.ts
```

## Quick start

Once installed, start pi and run:

```
/duet
```

## Commands

| Command | Description |
|---|---|
| `/duet` | Main entrypoint — plan a new task, import an existing plan, resume a paused run, or manage an active run. |
| `/duet-status` | Show current run state (phase, step, round, active child, pending interventions). Detects stale runs from previous sessions. |
| `/duet-abort` | Abort the currently running orchestration. Also works on stale runs from previous sessions. |
| `/duet-runs` | Full-screen interactive run manager — browse, resume, inspect, abort, or delete any duet run. |

## Keyboard shortcuts

| Shortcut | Description |
|---|---|
| `Alt+,` | Switch workspace to Activity pane |
| `Alt+.` | Switch workspace to Plan pane |
| `Ctrl+Shift+C` | Abort active duet run (when orchestration is running) |

---

## Planning modes

### Plan a new task

Select "Plan a new task" from the `/duet` menu, enter a goal description, and the planner + critic iterate until the plan is approved or max rounds are reached.

### Import an existing plan file

Select "Implement from an existing plan file" and pick a plan document from the repo. The planner converts it into the internal `PlanDraft` JSON schema, and the critic reviews it.

### Gap analysis (pre-review)

When importing an existing plan, you're offered:

```
Review plan for gaps before conversion?
▸ Yes — planner + critic analyze the plan for gaps first
  No — convert and start immediately
```

If enabled, the planner explores the codebase and analyzes the raw plan for:
- Missing implementation steps
- Unclear or ambiguous requirements
- Dependency issues between steps
- Technical feasibility problems given the current codebase
- Missing error handling, edge cases, or test coverage

The critic then validates and supplements the planner's findings. Any blocking issues are fed to the planner during conversion so they're addressed in the structured plan.

Gap analysis artifacts are saved to `.pi/duet/runs/<runId>/gap-analysis/`.

### Post-plan review

After plan approval, you can:
- **Review full plan** — opens a full-screen scrollable markdown viewer with keyboard navigation (`↑/↓/j/k` scroll, `PgUp/PgDn` page, `g/G` top/bottom, `q/Esc` close)
- **Summarize plan with a small model** — get a concise summary from a cheaper model
- **Add human feedback** — inject operator notes and run 2 more planning rounds
- **Implement next step** or **Run the full plan**

---

## Workspace UI

The duet workspace is a **persistent, non-overlay widget** rendered below the editor during active runs. No pop-ups, no modals.

### Dual-pane layout

The workspace has two togglable panes:

- **Activity pane** (default, `Alt+,`) — live streaming view of agent output
- **Plan pane** (`Alt+.`) — plan overview with step list and run metadata

### Activity pane header

The header adapts to the current phase:

**During execution:**
```
 ██████░░░░ 3/8  Add authentication middleware
```
Progress bar + step number + step title.

**During planning / gap analysis / importing:**
```
 planning  ·  round 2  ·  Gap analysis: plan.md  ·  changes_requested
```
Phase badge + round number + task title from `activeSummary` + last verdict.

### Activity pane content

- **Active child row** — currently running agent (role, model, phase: thinking/output/tools), tool count, output size, elapsed time with animated spinner
- **Gate check results** — inline `✓`/`✗` per check ID, updated in real time
- **Output tail** — last lines of streamed content (thinking, tool calls, text output)

### Plan pane

- Goal and step list with status indicators (✓ completed, **bold** current, dim future)
- Phase, round, execution mode, handoff mode, model info

### Status bar

Compact single-line status in the pi status bar:

```
duet:executing • step 2/5 • round:3 • impl:A rev:B  type to steer • >> to note other
```

---

## Run manager (`/duet-runs`)

Full-screen interactive browser for all duet runs:

```
── Duet Runs (11) ── ↑/↓ navigate · Enter select · d delete · q close

▸ ✓ Mar 18, 03:39  │ 4/4 steps      │ completed
    Replace belowEditor widgets with dual-pane...
  ◐ Mar 18, 23:57  │ 0/8 steps      │ planning
    Import plan from community-literacy-leaders...
  ✗ Mar 14, 06:14  │ 2/5 steps      │ executing step 2/5
    Zapier OAuth integration...
```

### Actions on selected run

- **Resume run** — rehydrates state and launches background orchestration (paused, executing, planning, aborted-with-plan)
- **View plan** — full-screen scrollable plan viewer
- **View summary** — scrollable markdown viewer for `run-summary.md` (compacted runs)
- **Abort run** — marks stale runs as aborted on disk
- **Delete run** — removes the run directory
- **Quick delete** — press `d` from the list

Runs are sorted newest-first with color-coded status icons:
- ✓ green — completed
- ⏸ yellow — paused
- ◐ blue — planning
- ▶ blue — executing
- ✗ red — aborted

---

## Operator steering

Interact with agents during active runs without any mode switch.

### Steer the active child

Type your message and send it. The text is prepended to the active child's prompt at the start of its next round.

```
This file already exists — update it in place instead of writing a new one.
```

### Queue a note for the inactive child

Prefix with `>>` to target the other agent:

```
>> Pay attention to the error types in types.ts — the reviewer missed a discriminated union.
```

### Intervention storage

Interventions are written to `.pi/duet/runs/<runId>/interventions.jsonl` — durable, auditable, survives pause/resume and pi restarts. The workspace shows pending counts per child.

---

## Execution

### Execution modes

- **Standard** — implementer and reviewer alternate on each step
- **Relay** — a single agent handles implementation with cheap controller snapshots between rounds; full checks reserved for final approval

### Gate checks

Configurable checks run after each step (lint, typecheck, unit tests, build). Results are captured as gate evidence under `.pi/duet/runs/<runId>/steps/<step>/`.

### Plan escalation

If an agent determines a step is structurally underplanned, it can signal `replan_needed`. The controller pauses and presents:

- **Add operator guidance and retry**
- **Replan from current step onward** — fresh planner+critic loop preserving completed steps
- **Continue anyway**
- **Pause for manual inspection**

Escalation artifacts are saved under `.pi/duet/runs/<runId>/steps/<step>/escalation-<n>/`.

---

## Run lifecycle

### Git integration

If `repo.requireGit` is `true` in config and no git repo exists, duet offers:

```
No git repository found. Duet requires git for diff tracking.
▸ Initialize git repo (git init + initial commit)
  Cancel duet run
```

Selecting "Initialize" runs `git init && git add -A && git commit` and proceeds. Git enables `captureDiffCheck` for reviewer visibility into step changes.

### Crash recovery

On startup, duet checks `.pi/duet/runs/*/state.json` for non-idle runs from previous sessions. `/duet-status` and `/duet-abort` detect these stale runs and show them with a `(stale — not actively running)` indicator.

### Abort

Three ways to abort:
- **Ctrl+Shift+C** — keyboard shortcut
- **`/duet-abort`** — explicit command
- **`/duet-runs`** → select run → Abort

### Closeout

On successful completion, duet offers:
- **Compact and keep summary** — preserves plan, summary, final step artifacts, escalation/operator notes, config/state snapshots
- **Keep full artifacts**
- **Delete the run**

A compact `duet-summary` message is appended to the parent pi session.

### Stale run cleanup

`/duet` offers cleanup for old runs:
- Compact old completed runs
- Archive stale paused/aborted/replan-needed runs
- Delete old aborted planning-only runs with no reusable plan

---

## Configuration

Config lives at `.pi/duet/config.json`:

```json
{
  "sideA": { "label": "Claude Opus", "model": "anthropic/claude-opus-4", "thinking": "high" },
  "sideB": { "label": "GPT-4o", "model": "openai/gpt-4o", "thinking": "off" },
  "planner": { "label": "Claude Opus", "model": "anthropic/claude-opus-4", "thinking": "high" },
  "critic": { "label": "GPT-4o", "model": "openai/gpt-4o", "thinking": "high" },
  "implementer": { "label": "Claude Sonnet", "model": "anthropic/claude-sonnet-4", "thinking": "high" },
  "reviewer": { "label": "Claude Opus", "model": "anthropic/claude-opus-4", "thinking": "high" },
  "executionMode": "relay",
  "startImplementer": "A",
  "maxPlanRounds": 10,
  "maxExecutionRounds": 10,
  "alternateByStep": true,
  "checks": {
    "static": { "cmd": "npm run lint && npm run typecheck", "timeoutSec": 300 },
    "unit": { "cmd": "npm test -- --maxWorkers=6", "timeoutSec": 600 }
  },
  "repo": {
    "requireGit": true,
    "requireCleanStart": false,
    "enforceCleanAfterStep": false,
    "captureDiffCheck": true
  }
}
```

### Key settings

| Setting | Default | Description |
|---|---|---|
| `maxPlanRounds` | 10 | Max planner+critic iterations before pausing. User is prompted to extend, add notes, or abort. |
| `maxExecutionRounds` | 10 | Max implementer+reviewer iterations per step. |
| `executionMode` | `"standard"` | `"standard"` (alternating impl+review) or `"relay"` (single agent with snapshots). |
| `alternateByStep` | `true` | Swap which side implements vs reviews on each step. |
| `repo.requireGit` | `true` | Require a git repo. If missing, offers to initialize one. |
| `repo.captureDiffCheck` | `true` | Run `git diff` after steps for reviewer visibility. |

---

## Artifacts

All run data lives under `.pi/duet/runs/<runId>/`:

```
.pi/duet/runs/<runId>/
├── config.snapshot.json       # Config at run start
├── state.json                 # Current run state (crash-recoverable)
├── plan.json                  # Approved plan
├── draft-plan.json            # Working plan draft
├── run-summary.md             # Compact summary (after closeout)
├── operator-notes.md          # Operator notes log
├── interventions.jsonl        # Durable intervention log
├── handoff.json               # Handoff metadata
├── gap-analysis/              # Pre-review gap analysis artifacts
│   ├── source-plan.md
│   ├── planner-analysis.md
│   ├── planner-review.json
│   └── critic-review.json
├── planning/
│   └── round-<n>/            # Per-round planner+critic artifacts
├── sessions/                  # Persistent child agent sessions
└── steps/
    └── <step>/
        ├── iteration-<n>/    # Per-iteration impl+review artifacts
        │   └── controller/   # Gate evidence and check outputs
        └── escalation-<n>/   # Escalation artifacts
```

---

## Architecture notes

- Child agents run in `--mode json` with persistent `--session-dir` and `--continue`
- Child agents are restricted to file-navigation/editing tools only by default
- The controller runs checks and captures evidence — agents never run checks themselves
- Model picker uses pi settings `enabledModels` scope when available, falls back to all authenticated models
- Child runner passes explicit `--thinking` levels per side
- Execution resumes tell agents they may be resuming partial work and should verify repo state
- Large controller artifacts (diffs, check stdout/stderr) are bounded to control run directory size
- Relay mode uses cheap controller snapshots between rounds, full checks only for final approval
- Interventions are routed by stable `childId` (`${side}-${role}`) for unambiguous targeting
