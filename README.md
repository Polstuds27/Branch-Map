# BranchMap

A local-first Windows desktop application that visually explains local Git repositories. Developed Through AI-Assisted Development.

BranchMap reads repositories directly from your disk. There is no cloud backend, no authentication, no telemetry, and nothing is ever uploaded.

---

## Purpose

BranchMap helps developers understand complex Git histories without memorising Git commands. It provides:

- **Visual commit graph** — see branch relationships, merge commits, and history topology at a glance
- **Branch comparison** — merge-base-aware diffs showing what changed on a feature branch vs. tip-to-tip comparison
- **File-level diffs** — unified diffs with additions/deletions clearly highlighted
- **Merge preview** — read-only conflict detection before you merge
- **Per-commit inspection** — see exactly what a commit changed (including root commits and merge resolutions)
- **Markdown reports** — export a shareable change summary
- **Optional local AI** — explain branches, commits, risks, and suggest tests using a local Ollama model (entirely offline)

---

**Key UI regions:**
- **Title bar** — window controls, repo name, branch, dirty status
- **Sidebar** — repository picker, recent repos, Git installation status
- **Commit History (left)** — topological graph with lanes, refs, click to select
- **Inspector / Diff (center)** — commit metadata or file diff explorer
- **AI Panel (right, collapsible)** — Ollama status, model selector, explanation actions, generated output

---

## Current Status — Milestone 4 Complete

| Feature | Status |
|---------|--------|
| Tauri 2 desktop shell (React 19 + TypeScript + Vite 8 + Tailwind CSS 4) | ✅ |
| Dark developer-tool UI: title bar, sidebar, workspace, inspector, status bar | ✅ |
| Git installation check & repository validation | ✅ |
| Commit history with pagination | ✅ |
| **Commit graph** — lane columns, merge nodes, connecting lines, ref decorations | ✅ |
| Commit inspector — metadata, parents, merge info | ✅ |
| Branch listing with HEAD/upstream | ✅ |
| **Branch comparison** — merge-base (`base...compare`) and direct (`base compare`) modes | ✅ |
| Per-file statuses (added/modified/deleted/renamed/copied/type-changed) + binary detection | ✅ |
| Line insertion/deletion counts | ✅ |
| Overlap detection (files changed on both sides since merge base) | ✅ |
| Unified diff viewer (size-capped) | ✅ |
| **Merge preview** via `git merge-tree --write-tree` | ✅ |
| Diff explorer — file list + unified diff side by side | ✅ |
| Folder picker + recent repositories | ✅ |
| **Windows installer** (`npm run desktop:build`) + desktop shortcut | ✅ |
| **Optional local AI** via Ollama — 4 explanation types, 6 UI states | ✅ |
| Markdown report export | ✅ |
| Per-commit file changes + diffs (root commits, merge commits) | ✅ |

---

## Prerequisites

| Tool | Status | Notes |
|------|--------|-------|
| Node.js 20+ | required | Developed against v24.4.1 |
| npm | required | Developed against 11.4.2 |
| Git CLI | required at runtime | Developed against 2.50.1 |
| Rust (stable, MSVC) | required to build | `rustup` toolchain |
| Visual Studio Build Tools | required to build | C++ workload + Windows SDK |
| WebView2 Runtime | required to run | Preinstalled on Windows 11 |
| Ollama | optional | For AI explanations only |

### Install Build Prerequisites (Windows)

```powershell
# Rust
winget install --id Rustlang.Rustup -e

# MSVC toolchain + Windows SDK (large download)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Close and reopen your terminal afterwards so `cargo` is on `PATH`.

---

## How to Use BranchMap

### 1. First Launch

```powershell
# Clone or navigate to the project
cd Branch Map

# Install frontend dependencies
npm install

# Development mode (hot reload, Vite dev server on port 1420)
npm run desktop:dev
```

The app window opens. If you see "BranchMap needs the desktop shell", you ran `npm run dev` instead of `npm run desktop:dev`.

### 2. Open a Repository

1. Click **"Open Repository"** in the sidebar (or press `Ctrl+O`)
2. Select a folder containing a `.git` directory
3. BranchMap validates it and loads:
   - Commit history (graph + list)
   - Branches
   - Working tree status

> **Tip:** BranchMap resolves subdirectories — if you pick a folder inside a repo, it opens the repository root and tells you.

### 3. Explore Commit History

- **Click any commit** to see its details in the inspector panel
- **Graph lines** show parent-child relationships; merge commits have multiple parents
- **Ref tags** (HEAD, branch names, tags) appear on their commits
- **Load more** at the bottom fetches older history (200 commits per page)

### 4. Compare Branches

1. Switch to the **Compare** tab (toolbar at top)
2. Pick **Base branch** (typically `main` or `develop`)
3. Pick **Compare branch** (your feature branch)
4. Choose **Mode**:
   - **Merge base** (default) — what changed on the feature branch since it forked (`git diff base...compare`)
   - **Direct** — tip-to-tip difference right now (`git diff base compare`)
5. Click **Compare**

Results show:
- Ahead/behind commit counts
- Commit list (commits only on compare branch)
- File list with status, line stats, and **overlap** flag (changed on both sides)
- Click a file to see its unified diff

### 5. Merge Preview

In the Compare tab, click **Preview Merge**. This runs `git merge-tree --write-tree` (read-only, writes temporary tree objects only). Results show:
- ✅ Clean — Git reports no conflicts (estimate, not a guarantee)
- ⚠️ Conflicts — conflicting paths listed (overlap ≠ guaranteed conflict)

### 6. Inspect a Single Commit

1. Select a commit in the history graph
2. The **Details** panel shows:
   - Commit metadata (hash, author, date, parents, merge flag)
   - File changes with status and line counts
   - **Parent mode** toggle: First Parent (what the merge brought in) vs Combined (conflict resolutions only)
3. Click a file to see its diff

### 7. Export Markdown Report

In the Compare tab, click **Export Report** → choose location → saves a `.md` file with:
- Repository name, branches compared, mode
- Merge base, ahead/behind counts
- File table with statuses and stats
- Merge preview result
- Overlap warning

### 8. AI Explanations (Optional, Requires Ollama)

1. Ensure Ollama is installed: `winget install Ollama.Ollama` or from ollama.com
2. Pull a model: `ollama pull qwen2.5:0.5b` (default, fast) or `qwen2.5:1.5b` / `qwen2.5:3b`
3. Open the **AI** tab (sparkles icon in toolbar)
4. Panel shows status: *Checking → Starting → Loading → Ready*
5. If Ollama isn't running, click **Start Ollama**
6. Select a model from the dropdown
7. (Optional) Enable **Warm up model at startup** — loads weights into RAM
8. Click an explanation button:
   - **Explain branch comparison** — summary of what the feature branch changes
   - **Explain commit** — what the selected commit changed and likely intent
   - **Change risk** — risk observations based on file types, overlap, diff size
   - **Suggested tests** — verification steps appropriate to the changes
9. Read the output — **VERIFIED FACT** labels = from Git data; **INFERENCE** = model interpretation

> **Important:** The 0.5B model is fast (~3s) but can hallucinate. The 1.5B model is slower (~20s) but more faithful to the provided facts. Treat all AI output as a review prompt, not an authoritative summary.

---

## Development

```powershell
# Full development (Tauri window + hot reload)
npm run desktop:dev

# Frontend only (browser at http://localhost:1420, no Rust)
npm run dev
```

`desktop:dev` starts Vite on port 1420 (fixed, `strictPort`) and launches the Tauri window. A port clash fails loudly.

---

## Build

```powershell
npm run desktop:build
```

Produces an installable Windows bundle:
```
src-tauri/target/release/bundle/nsis/BranchMap_0.1.0_x64-setup.exe
```

Run the installer once, then launch from the desktop shortcut or `%LOCALAPPDATA%\BranchMap\branchmap.exe`.

To recreate the desktop shortcut (targets the **packaged** app, never dev):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

---

## Other Commands

| Command | Purpose |
|---------|---------|
| `npm run build` | Type-check (`tsc -b`) + build frontend to `dist/` |
| `npm run typecheck` | Type-check only |
| `npm run lint` | oxlint |
| `npm run tauri <cmd>` | Raw Tauri CLI passthrough |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust unit tests (Git parsing, AI prompt guardrails) |

---

## Local AI (Ollama, Optional)

BranchMap explains changes using a **local** Ollama model. The feature is entirely optional: with Ollama missing or stopped, every Git feature still works.

- Endpoint is loopback only (`http://127.0.0.1:11434`); override with `BRANCHMAP_OLLAMA_ENDPOINT`. Repository content is never sent anywhere else.
- Default model: **`qwen2.5:0.5b`** (small and fast). Any installed model can be selected in the AI panel.
- BranchMap **never downloads a model for you** and never loads more than the one model you pick. If the model is missing, the panel shows the exact command:
  ```powershell
  ollama pull qwen2.5:0.5b
  ```
- If Ollama is installed but stopped, the panel offers **Start Ollama**. It probes the endpoint first, so a running server is never duplicated, and BranchMap never terminates an Ollama process — including when BranchMap itself closes.
- Model warm-up is **opt-in** (a checkbox in the panel), because loading weights costs memory and CPU. Startup otherwise only performs a cheap status probe.
- Panel states: Checking, Starting Ollama, Loading model, Ready, Unavailable, Error. Initialisation is asynchronous and retryable without restarting the app.

### What the Model Is Told

Prompts are built in `src-tauri/src/ollama.rs` and always instruct the model to:
- Use only the supplied data
- Separate **VERIFIED FACT** from **INFERENCE** using those labels explicitly
- Never claim a change caused a bug, and never claim a change is safe
- Never claim a merge will succeed
- If the data is insufficient, say so plainly instead of speculating

Inputs are bounded (facts, file lists, and diff excerpts are all clipped) and output is sanitised for control characters and length.

**Be aware:** a 0.5B model is fast but noticeably weaker than 1.5B/3B — it can misstate comparison direction or skip the fact/inference labelling. Treat its output as a prompt for your own review, never as an authoritative summary.

---

## Architecture

```
src/                     React frontend (presentation + state)
  components/            One file per UI region
  lib/graph.ts           Pure lane-assignment algorithm for the commit graph
  lib/time.ts            Relative/absolute timestamp formatting
  lib/aiRequests.ts      Builds grounded AiRequest from real Git data
  lib/report.ts          Markdown report generation
  services/git.ts        Typed wrappers around Rust commands — the only place invoke() is called
  services/ollama.ts     Typed wrappers around Ollama commands
  types.ts               Types shared with the Rust payloads
src-tauri/src/
  lib.rs                 All Git subprocess handling, command definitions, and tests
  ollama.rs              Ollama HTTP client, prompt building, inference
  diag.rs                Bounded, privacy-safe AI diagnostics ring buffer
  main.rs                Tauri entry point
src-tauri/capabilities/  Tauri v2 permission grants (minimal)
```

### Comparison Semantics

| Question | Git | BranchMap Mode |
|----------|-----|----------------|
| What changed on the feature branch since it forked? | `git diff base...compare` | `mergeBase` (default) |
| What differs between the two tips right now? | `git diff base compare` | `direct` |
| Which commits are only on the comparison branch? | `git log base..compare` | always, in both modes |

Files changed on **both** sides since the merge base are labelled **overlap**. That is a risk signal, not a conflict: Git frequently merges overlapping edits cleanly.

### Merge Preview Caveat

Git 2.50 removed the old read-only three-argument `merge-tree` form (it is now a silent no-op). BranchMap therefore uses `git merge-tree --write-tree`, which writes temporary tree objects into the object database. It never touches refs, the index, or the working tree, and the objects are unreferenced garbage that `git gc` reclaims. This is stated in the UI next to every preview result.

### Rules the Codebase Follows

- **Git runs only in Rust.** Commands are invoked with argument arrays, never shell strings, so repository paths and contents can never be interpreted as commands.
- **Read-only.** Every Git call sets `GIT_OPTIONAL_LOCKS=0` and runs only `rev-parse`, `status`, `rev-list`, `log`, `for-each-ref`, `merge-base`, `diff`, and `merge-tree`. Nothing in this build changes refs, the index, or the working tree, and no destructive command (`reset`, `clean`, `push`, `commit`, `merge`, `rebase`, checkout) exists.
- **Bounded.** Each Git subprocess has a 10s timeout and capped output; a wedged process is killed instead of freezing the UI.
- **Structured errors.** Failures return `{ kind, message, hint }` so the UI can explain what to do next.
- **No fake data.** Unimplemented features render explicit empty states. Git facts shown to the user always come from a real command.
- **Topological order.** History is read with `--topo-order` so a parent never appears above its children — the graph columns depend on this.
- **Diff text is never treated as markup.** Unified diffs are rendered as React text nodes only; repository content is untrusted input and is never injected as HTML.
- **AI is local-only.** Ollama communication restricted to loopback. No repository data leaves the machine. No telemetry.

---

## Troubleshooting

**`error: linker 'link.exe' not found`** — the MSVC build tools are missing or `cargo` cannot see them. Install the Build Tools workload above, then restart the terminal.

**Git not detected in the app** — BranchMap calls `git --version` using `PATH`. If Git works in your terminal but not in the app, launch BranchMap from a shell that has the same environment.

**Port 1420 already in use** — something already owns the fixed port. Free it, or change `server.port` in `vite.config.ts` *and* `build.devUrl` in `src-tauri/tauri.conf.json` together.

**AI panel shows "Unavailable"** — check Ollama is running (`ollama ps`) and the model is pulled (`ollama list`). The panel shows the exact `ollama pull` command needed.

**Tests fail intermittently with "Not a Git working tree"** — run with `--test-threads=1` to avoid temp directory collisions:
```powershell
cargo test --manifest-path src-tauri/Cargo.toml -- --test-threads=1
```

---

## License

MIT — see `LICENSE` (if present) or the repository root.
