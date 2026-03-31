---
name: prepare-for-duet
description: "Prepare goals or plan files for /duet, the two-agent orchestrated coding system. Use when the user wants to plan a multi-step coding task, break down a large feature, or set up an automated plan→implement→review loop."
---

# Prepare for Duet

Help the user prepare input for `/duet` — pi's two-agent orchestration system that plans, implements, and reviews multi-step coding tasks automatically.

## When to use duet vs. doing it directly

**Use duet when:**
- The task touches 5+ files or multiple modules/layers (backend + frontend, API + DB + UI)
- There are ordering dependencies (migration before API, API before UI)
- The task benefits from plan→implement→review cycles
- The user explicitly asks for a plan or mentions duet

**Don't use duet when:**
- It's a single-file change or quick fix
- The task is exploratory ("look at this and tell me what's wrong")
- The user just wants advice, not implementation

If the task is too small for duet, say so and just do it directly.

## Two paths into duet

### Path 1: Goal string → "Plan a new task"

Best when the task is **clear but the user doesn't have strong opinions about step ordering**. Duet's planner agent will explore the codebase and create a structured plan with critic review.

**Output:** Give the user a goal string they can paste into `/duet` → "Plan a new task".

A good goal string is:
- **Specific about the deliverable**, not vague ("Add JWT auth with refresh tokens to the Express API" not "add auth")
- **Scoped** — mentions what's in and out of scope
- **Tech-aware** — names the stack, frameworks, or patterns to follow if relevant
- **Constraint-aware** — mentions important boundaries (e.g. "backend only", "don't touch the DB schema", "must be backward compatible")

Examples:

```
Good: "Add paginated ticket list API endpoint to the Spring Boot backend with
Flyway migration for a priority enum, filtered search by status/assignee/priority,
and OpenAPI documentation. Backend only — do not modify frontend."

Bad: "Add ticket features"

Good: "Refactor the authentication module from Express middleware to a standalone
service class with dependency injection, preserving all existing route behavior
and adding unit tests for each auth flow (login, refresh, logout, password reset)."

Bad: "Clean up auth code"
```

### Path 2: Plan file → "Implement from existing plan file"

Best when:
- The task is **complex with specific sequencing** the user cares about
- There are **cross-cutting concerns** (backend + frontend + infra) that need explicit separation
- The user has already discussed the approach and has opinions about how to break it down
- Previous duet runs failed due to vague or misordered steps

**Output:** Write a `.md` plan file to the repo root (e.g., `duet-plan.md`). The user selects it via `/duet` → "Implement from existing plan file".

## Writing a plan file

Duet's planner converts the `.md` into a structured `PlanDraft` JSON with steps. The clearer your `.md`, the better the conversion. Duet can optionally run **gap analysis** (planner + critic review the plan for missing steps, ambiguities, and feasibility issues before conversion).

### Template

```markdown
# Goal

<One paragraph describing the overall objective and success criteria>

## Constraints

- <Boundary or non-goal>
- <Tech stack requirements>
- <Backward compatibility needs>

## Steps

### Step 1: <Clear title>

<What this step delivers. Be specific about which files/modules are created or modified.>

**Scope:** <Explicitly state what's in and out of scope for this step>

**Deliverables:**
- <Concrete output 1>
- <Concrete output 2>

**Checks:** <Which checks must pass — e.g., lint, typecheck, unit, build>

### Step 2: <Clear title>

**Depends on:** Step 1

<Description...>

...
```

### Step-writing rules

These prevent the most common duet failures:

1. **One layer per step.** Don't mix backend and frontend in the same step. Don't mix DB migration and API code with UI. Agents get confused about which codebase to work in.

2. **Name the files.** "Add the TicketPriority enum to `backend/src/main/java/.../TicketPriority.java`" beats "Add a priority enum somewhere."

3. **State what NOT to touch.** If step 3 is backend-only, say "Do NOT modify any files in `frontend/src/`." Agents drift toward whatever code is most visible.

4. **Order by dependency.** Migrations before entities, entities before services, services before controllers, backend API before frontend consumers.

5. **Keep steps independently verifiable.** Each step should leave the project in a state where configured checks pass. Don't have a step that "starts" something and another that "finishes" it.

6. **Scope checks per step.** Not every step needs every check. A migration-only step might only need `build`. A frontend component step might skip `build` if it's slow. Valid check IDs come from `.pi/duet/config.json` — read it to see what's configured.

## Before preparing the plan

**Explore the codebase first.** This is the most important step. Understand the project layout, directory structure, frameworks, naming conventions, and existing patterns before writing any steps. Plans that reference wrong paths, non-existent modules, or unfamiliar patterns cause agent confusion and escalation loops during implementation.

Specifically:
- Map the top-level structure (`ls`, `find`, read key config files like `package.json`, `build.gradle`, `tsconfig.json`, etc.)
- Identify the major modules/layers (backend, frontend, shared, infra) and where they live
- Read a few representative files to understand coding style and patterns
- Check for existing tests, migrations, DTOs, or similar artifacts that the plan steps need to extend (not reinvent)

**Research what you don't know.** Duet's child agents have NO web research capability — they only get file tools. If you're unsure about an API, library, or pattern, research it NOW so you write accurate steps. Use the right tool for the question:
- `claude_research` for current API docs, library versions, breaking changes, migration guides
- `chatgpt_research(mode='extended_pro')` for hard design questions — architecture tradeoffs, step ordering, complex reasoning
- `chatgpt_research(mode='deep_research')` for comprehensive domain investigation — surveying approaches, comparing libraries

Research feeds your understanding — then write concrete steps from that informed position. Don't dump raw research into steps.

**Note:** For the automated research pipeline (codebase crawl + parallel research + Extended Pro synthesis), use `/duet` → "Plan a new task (deep research)" instead of preparing a plan file manually.

**Then check the practical details:**
- Read `.pi/duet/config.json` for available check IDs (e.g., `lint`, `typecheck`, `unit`, `build`) — the plan must reference only valid IDs
- Glance at `git status` — if there's uncommitted work or an in-progress duet run under `.pi/duet/runs/`, flag that to the user before creating a new plan

## Handoff context

When the user runs `/duet`, they'll be asked about **handoff context**:

- **No handoff** — duet starts fresh with no conversation context
- **Include summary of current conversation** — a summary of the current pi session is passed to duet's agents
- **Include all current conversation context** — the full session is passed (large, expensive)

**Suggest to the user:**
- If you just had a detailed discussion about the task with the agent, suggest **"Include summary"** — the planning/implementation agents will benefit from the design context.
- If starting from a cold plan file with no prior discussion, suggest **"No handoff"** or starting `/duet` in a fresh pi session to keep context clean and costs down.

## Output format

After preparing the goal or plan file, tell the user exactly what to do:

**For goal-only:**
> Run `/duet` → select "Plan a new task" → paste this goal:
>
> `<the goal string>`
>
> Since we discussed this in detail, select "Include summary of current conversation" when asked about handoff.

**For plan file:**
> I've written the plan to `duet-plan.md`. Run `/duet` → select "Implement from existing plan file" → select `duet-plan.md`.
>
> I'd recommend selecting "Yes" for gap analysis — the planner and critic will review the plan for missing steps before converting it.

## Common pitfalls to avoid

- **Vague step descriptions** → agents interpret loosely, do wrong work
- **Mixed frontend+backend steps** → agents gravitate to one side and ignore the other
- **Steps that assume agent memory** → each step is a fresh prompt; state what's needed
- **Too many steps** → 5-15 is typical; 16+ means steps are probably too granular or should be split into separate duet runs
- **Too few steps** → 1-3 steps for a large task means each step is too big to verify
- **Missing "don't touch X" constraints** → agents will "helpfully" modify files outside scope
