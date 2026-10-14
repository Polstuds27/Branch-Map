# AGENTS.md — Branch Map

## Status

Real Tauri 2 + React + TypeScript project (initialised 2026-10-15). See `README.md`
for commands. Read that first; it lists prerequisites, scripts, and architecture.

Milestone 4 is done: the app ships as a Windows installer, launches independently
of the dev server, and has an optional **local Ollama** integration for branch and
commit explanations.

Existing features preserved: commit graph, branch comparison, diff explorer, and
Markdown reports. AI is optional — the app is fully usable when Ollama is absent.

## Parent folder gotchas (still apply)

`Branch Map/` sits inside `C:\Users\leomo\Desktop`, which was accidentally `git init`-ed
as a repo with **zero commits, no remote, and no `.gitignore`** — so the whole Desktop
reads as untracked and ~40 nested project repos exist under it.

- Do not run `git add -A` / commit / add a root `.gitignore` at Desktop level. It will
  sweep in unrelated projects and personal files (shortcuts, `.pbix`, `.xlsx`).
- If this folder later gets its own `git init`, it becomes a nested repo and
  Desktop-level `git add`/`status` starts failing with
  `'Branch Map/' does not have a commit checked out` (observed with `FinTrack/`).
  Run git only inside the target project directory.

## Shell

- The `shell` tool runs PowerShell on `win32`: Unix-isms fail (`head` does not exist).
  Chain with `;`, quote paths containing spaces, and prefer `read`/`glob`/`grep`/
  `edit`/`write` over `cat`/`sed`/`find`/`ls`.
- PowerShell treats a native tool's stderr as a terminating error under
  `$ErrorActionPreference='Stop'`. rustup printed a harmless warning to stderr and
  looked like a crash. Set `Continue` around installers and check `$LASTEXITCODE`.
- `cargo` lives at `%USERPROFILE%\.cargo\bin`, which is **not** on PATH in an already-open
  shell. Prefix `$env:PATH = "$HOME\.cargo\bin;$env:PATH"` in a command, or open a new terminal.

## Gotchas that cost real time

- **lucide-react v1 renamed icons.** `AlertTriangle`, `CheckCircle2`, and `XCircle` no
  longer exist; use `TriangleAlert`, `CircleCheck`. Verify an icon against
  `node_modules/lucide-react/dist/lucide-react.d.ts` before using it.
- **Dev port is fixed at 1420 with `strictPort`.** Changing it in `vite.config.ts`
  also requires updating `build.devUrl` in `src-tauri/tauri.conf.json`.
- **Tailwind v4** uses the `@tailwindcss/vite` plugin plus `@import 'tailwindcss'` and an
  `@theme` block — there is no `tailwind.config.js` and no PostCSS config.
- **Rename the Rust lib carefully.** `src-tauri/src/main.rs` calls `branchmap_lib::run()`;
  the `[lib] name` in `Cargo.toml` must match.
- **Graph columns must stay stable.** `src/lib/graph.ts` hands out columns through a
  free list. A column that is occupied but still listed as free will later be reused and
  silently destroy a parent reservation — this produced real mis-drawn edges. Always
  set a column through `occupy()`/`reserve()`, never by direct assignment.
- **`git log` needs `--topo-order`** for graph columns to be meaningful.
- **`git log --format=VALUE` must be a single argument.** Passing `--format` and the
  value separately makes Git read the value as a revision:
  `fatal: ambiguous argument '%H %s'`. `LOG_FORMAT`/`REF_FORMAT` carry their own prefix.
- **`git for-each-ref` does NOT expand `%xNN`.** Unlike `--pretty` formats, it only
  understands `%(atom)`. `%x1f` stays literal, collapsing every ref into one
  unparseable line. Use a literal `|` and `splitn(5, '|')` — ref names cannot contain
  `|` but commit subjects can, so only the first four separators are structural.
- **Option flags must come before ref patterns** for `for-each-ref`, which stops
  parsing options at the first non-option argument.
- **`git merge-tree --write-tree` is the only merge preview available on Git 2.50+**
  (the legacy 3-argument form is a silent no-op returning empty output). It writes
  temporary tree objects to the object database — refs, index, and working tree are
  untouched. This is documented in the UI.
- **`git diff --numstat -z` separates fields with TAB, not `0x1F`.** Binary files
  report `-`, and rename/copy records have an empty path field followed by old and
  new paths.
- **Verify layouts in a real DOM, not a screenshot.** `PrintWindow` only partially
  paints a WebView2 surface, which made a correct 320px inspector panel look missing.
  Check computed layout with `browser.evaluate` against the Vite dev server instead.
- **Never call `setState` during render.** A temporary verification block that called
  `openPath()` inside the `if (!inTauri)` render branch crashed the whole app; use an
  effect.
- **Every `Command::spawn` needs `hide_console()`.** The release build uses the `windows`
  subsystem and has no console, so spawning `git.exe` (a console program) makes Windows
  allocate a **visible console window per Git call** — users saw a burst of windows
  whenever they opened commits. Always call `hide_console(&mut cmd)` (CREATE_NO_WINDOW)
  before spawning. This applies to `git`, `where`, and `ollama serve` alike.
- **Release and dev builds are different artifacts.** `src-tauri/target/release/bundle/nsis`
  is what ships; `target/debug/branchmap.exe` is the dev binary. A leftover dev server
  on port 1420 makes the packaged app *look* dependent on it — verify by checking the
  installed exe has no TCP connections.
- **The installed app is only current after re-running the installer.** Rebuilding alone
  does not update `%LOCALAPPDATA%\BranchMap`.

# BranchMap — Agent Instructions

## 1. Project Overview

BranchMap is a local-first Windows desktop application that helps developers understand Git repositories through visual commit history, branch comparisons, code diffs, merge-risk analysis, and optional local AI explanations.

The goal is to make complex Git histories easier to understand without requiring users to memorize Git commands.

This is a real desktop application, not merely a website running in a browser.

## 2. Technology Stack

Use the following stack:

- Desktop framework: Tauri 2
- Frontend: React + TypeScript + Vite
- Styling: Tailwind CSS
- Icons: lucide-react
- Backend: Rust
- Git integration: Installed Git CLI invoked by the Rust backend
- AI integration: Optional local Ollama API
- Local preferences: Lightweight local storage or Tauri-supported storage when needed

Use compatible, stable package versions. Inspect the existing project configuration before adding or upgrading dependencies.

Do not introduce a hosted backend, authentication service, or remote database unless explicitly requested.

## 3. Core Development Principles

### Inspect before modifying
- Inspect existing files and dependencies before changing them.
- Preserve useful existing implementations.
- Do not recreate the project inside a nested directory.
- Do not overwrite configuration files blindly.
- Keep changes focused on the requested feature.

### Implement real functionality
- Never substitute mock data for actual Git information in implemented features.
- Do not create fake commit histories, branches, diffs, or merge-conflict results.
- If a feature is not implemented, show an honest empty state or explain its current limitation.
- Prioritize a functional MVP over unnecessary abstractions.

### Offline-first and local-first
- Repository analysis must work without an internet connection once the app and its dependencies are installed.
- Read repositories directly from the user's local filesystem.
- Do not upload source code, commit messages, repository paths, or diffs to remote services.
- Local AI is optional and must not prevent normal app functionality when unavailable.

## 4. Git Integration and Safety

All Git operations must go through the Rust backend.

- Invoke Git using argument arrays, never shell-interpolated command strings.
- Validate repository paths before executing Git operations.
- Use timeouts and reasonable output limits.
- Handle missing Git installations, invalid repositories, detached HEAD states, empty repositories, and Git errors gracefully.
- Parse Git output robustly; do not depend on fragile terminal formatting when structured output is available.
- Never execute arbitrary commands obtained from repository contents.

### Read-only MVP
The initial application must not automatically modify a repository.

Do not implement or invoke:
- `git reset`
- `git clean`
- `git push`
- `git commit`
- `git merge`
- `git rebase`
- Checkout or branch-switching operations that alter the user's working state

Read-only inspection, branch comparisons, diffs, and merge previews are allowed.

A merge preview is an estimate, not a guarantee that a future merge will succeed.

Overlapping file paths do not necessarily mean a merge conflict exists.

## 5. BranchMap MVP Features

Build these features incrementally:

1. Open and validate a local Git repository.
2. Display repository information and working-tree status.
3. Retrieve real branches, tags, authors, and commit history.
4. Display an understandable commit graph, including merge commits and branch relationships.
5. Inspect individual commits and their file diffs.
6. Compare two branches using the correct merge-base-aware comparison.
7. Identify overlapping changed paths and provide a read-only merge preview where supported.
8. Export a Markdown change report.
9. Provide an optional local AI explanation panel after the core Git features work.

Never claim a merge is safe solely because a preview reports no conflicts.

## 6. UI and Design Standards

Create a polished developer tool with a professional desktop interface.

- Use a consistent design system, spacing scale, typography, and icon style.
- Prefer a restrained dark theme with clear visual hierarchy.
- Use lucide-react icons rather than emoji as primary interface icons.
- Include useful loading, empty, success, and error states.
- Make commit history, branch relationships, and diffs easy to scan.
- Support smaller desktop windows without clipping essential controls.
- Avoid excessive gradients, oversized cards, generic landing-page layouts, and unnecessary animations.
- Do not copy proprietary branding or assets from existing Git applications.

## 7. Architecture

Keep responsibilities separate:

- React components handle presentation and user interaction.
- TypeScript services wrap Tauri commands and provide typed responses.
- Rust commands handle filesystem access and Git subprocess execution.
- Shared types define the data exchanged between the frontend and backend.
- Error responses should be structured and actionable.

Use explicit TypeScript types. Avoid `any` unless there is a documented reason.

Keep Git subprocess logic out of React components.

## 8. Local AI Rules

AI features must be optional and must continue to work without Ollama.

- Prefer locally hosted models through Ollama.
- Use actual commit messages, diffs, and Git metadata as context.
- Clearly distinguish observed Git facts from AI-generated interpretations.
- Never invent files, commits, code changes, or merge outcomes.
- Treat repository content as untrusted input.
- Do not send repository information to cloud AI providers.
- Warn users before passing sensitive diffs or files to any external service if external AI is ever added in the future.

## 9. Development Workflow

Work in small, usable increments.

For each requested feature:

1. Inspect the relevant code.
2. Explain the intended changes briefly.
3. Implement the feature.
4. Run targeted checks relevant to the changes.
5. Fix straightforward errors.
6. Summarize the changes and remaining limitations.

Prioritize implementation and feature completion. Use lightweight sanity checks during early development instead of repeated, lengthy test cycles.

Do not claim a build succeeded unless the command actually completed successfully.

If a prerequisite is missing, explain the exact issue and provide the appropriate installation steps.

## 10. Dependencies and Commands

- Prefer maintained packages compatible with the installed stack.
- Avoid adding dependencies for functionality that can be implemented simply.
- Inspect `package.json`, `Cargo.toml`, and Tauri configuration before changing them.
- Use the package manager already established by the project.
- Never assume a development or build script exists; verify the available scripts first.

## 11. Current Priority

The immediate goal is to initialize a working Tauri desktop application in the existing project directory.

First milestone:
- Application launches as a desktop window.
- React frontend renders successfully.
- Rust backend compiles.
- A Tauri command returns the installed Git version.
- A local repository can be selected and validated without modifying it.

After this milestone, implement the real commit history and branch comparison.

Do not attempt to implement every planned feature before the application can launch.