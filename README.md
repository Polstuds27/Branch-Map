# BranchMap

A local-first Windows desktop application that visually explains local Git repositories.

BranchMap reads repositories directly from your disk. There is no cloud backend, no
authentication, no telemetry, and nothing is ever uploaded.

## Current status — milestone 4

Implemented:

- Tauri 2 desktop shell with React 19 + TypeScript + Vite 8 + Tailwind CSS 4.
- Dark developer-tool UI: title bar, repository sidebar, main workspace, inspector
  panel, status bar.
- `check_git_installation` — reports whether the Git CLI is installed and which version.
- `validate_repository` — validates a local folder and returns real metadata.
- `list_commits` — real commit history with hash, subject, author, date, parents,
  refs, and merge flag; paginated.
- **Commit graph** — lane columns assigned from real parent hashes, merge nodes,
  connecting lines, ref decorations, and click-to-select.
- **Commit inspector** — subject, author, email, dates, parent hashes, merge info.
- `list_branches` — real local branches with HEAD marker and upstream.
- `compare_branches` — merge base, ahead/behind counts, `base..compare` commits, and
  per-file changes (added / modified / deleted / renamed / copied / type-changed,
  with binary detection) plus insertions and deletions. Supports `mergeBase`
  (`base...compare`) and `direct` (`base compare`) modes, and flags files changed on
  both sides since the merge base.
- `get_file_diff` — real unified diff for one path, size-capped.
- `preview_merge` — read-only merge preview via `git merge-tree`.
- **Diff explorer** — file list with statuses and stats beside a unified diff view
  that renders additions and deletions distinctly.
- Folder picker and a local recent-repositories list.
- **Windows installer** (`npm run desktop:build`) and a desktop shortcut to the
  packaged application.
- **Optional local AI** via Ollama: branch summaries, commit explanations,
  change-risk observations, and suggested tests — all grounded in real Git data.

Not implemented yet — these show honest empty states rather than placeholder data:

- File diffs for an individual commit (the inspector shows metadata only).
- Markdown report export.
- The optional local AI explanation panel (inert placeholder).

## Prerequisites

| Tool | Status | Notes |
| --- | --- | --- |
| Node.js 20+ | required | Developed against v24.4.1 |
| npm | required | Developed against 11.4.2 |
| Git CLI | required at runtime | Developed against 2.50.1 |
| Rust (stable, MSVC) | required to build | `rustup` toolchain |
| Visual Studio Build Tools | required to build | C++ workload + Windows SDK |
| WebView2 Runtime | required to run | Preinstalled on Windows 11 |

Install the two Windows build prerequisites if you do not have them:

```powershell
# Rust
winget install --id Rustlang.Rustup -e

# MSVC toolchain + Windows SDK (large download)
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override `
  "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Close and reopen your terminal afterwards so `cargo` is on `PATH`.

## Development

```powershell
npm install
npm run desktop:dev
```

`desktop:dev` starts Vite on port 1420 and launches the Tauri window. The port is
fixed (`strictPort`) so a clash fails loudly instead of the Rust shell silently
missing the frontend.

Frontend-only work (fast iteration in a browser, no Rust):

```powershell
npm run dev
```

The browser view detects that it is not running inside Tauri and says so rather
than failing with an opaque IPC error.

## Build

```powershell
npm run desktop:build
```

Produces an installable Windows bundle under `src-tauri/target/release/bundle/`.

## Other commands

| Command | Purpose |
| --- | --- |
| `npm run build` | Type-check (`tsc -b`) and build the frontend to `dist/` |
| `npm run typecheck` | Type-check only |
| `npm run lint` | oxlint |
| `npm run tauri <cmd>` | Raw Tauri CLI passthrough |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Rust unit tests (Git parsing, AI prompt guardrails) |

### Development vs production launch

These are different: development uses a Vite dev server on port 1420, production
runs a self-contained executable with the frontend embedded.

```powershell
# Development (requires the source tree + Node)
npm run desktop:dev

# Production build -> src-tauri\target\release\bundle\nsis\BranchMap_<version>_x64-setup.exe
npm run desktop:build

# Production launch: run the installer once, then use the desktop shortcut
# (or %LOCALAPPDATA%\BranchMap\branchmap.exe)
```

To (re)create the desktop shortcut — it targets the **packaged** app, never
`npm run desktop:dev`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-desktop-shortcut.ps1
```

The script resolves the install location at run time, so it contains no hardcoded
project path and keeps working if the project moves.

## Local AI (Ollama, optional)

BranchMap explains changes using a **local** Ollama model. The feature is entirely
optional: with Ollama missing or stopped, every Git feature still works.

- Endpoint is loopback only (`http://127.0.0.1:11434`); override with
  `BRANCHMAP_OLLAMA_ENDPOINT`. Repository content is never sent anywhere else.
- Default model: **`qwen2.5:0.5b`** (small and fast). Any installed model can be
  selected in the AI panel.
- BranchMap **never downloads a model for you** and never loads more than the one
  model you pick. If the model is missing, the panel shows the exact command:

  ```powershell
  ollama pull qwen2.5:0.5b
  ```

- If Ollama is installed but stopped, the panel offers **Start Ollama**. It probes
  the endpoint first, so a running server is never duplicated, and BranchMap never
  terminates an Ollama process — including when BranchMap itself closes.
- Model warm-up is **opt-in** (a checkbox in the panel), because loading weights
  costs memory and CPU. Startup otherwise only performs a cheap status probe.
- Panel states: Checking, Starting Ollama, Loading model, Ready, Unavailable, Error.
  Initialisation is asynchronous and retryable without restarting the app.

### What the model is told

Prompts are built in `src-tauri/src/ollama.rs` and always instruct the model to use
only the supplied data, to separate **VERIFIED FACT** from **INFERENCE**, never to
claim a change caused a bug or is safe, and never to claim a merge will succeed.
Inputs are bounded (facts, file lists, and diff excerpts are all clipped) and
output is sanitised for control characters and length.

**Be aware:** a 0.5B model is fast but noticeably weaker than 1.5B/3B — it can
misstate comparison direction or skip the fact/inference labelling. Treat its
output as a prompt for your own review, never as an authoritative summary.

## Architecture

```text
src/                     React frontend (presentation + state)
  components/            One file per UI region
  lib/graph.ts           Pure lane-assignment algorithm for the commit graph
  lib/time.ts            Relative/absolute timestamp formatting
  services/git.ts        Typed wrappers around Rust commands — the only place invoke() is called
  types.ts               Types shared with the Rust payloads
src-tauri/src/lib.rs     All Git subprocess handling, command definitions, and tests
src-tauri/capabilities/  Tauri v2 permission grants
```

### Comparison semantics

These are kept deliberately distinct, because mixing them up gives wrong answers:

| Question | Git | BranchMap mode |
| --- | --- | --- |
| What changed on the feature branch since it forked? | `git diff base...compare` | `mergeBase` (default) |
| What differs between the two tips right now? | `git diff base compare` | `direct` |
| Which commits are only on the comparison branch? | `git log base..compare` | always, in both modes |

Files changed on **both** sides since the merge base are labelled **overlap**. That
is a risk signal, not a conflict: Git frequently merges overlapping edits cleanly.

### Merge preview caveat

Git 2.50 removed the old read-only three-argument `merge-tree` form (it is now a
silent no-op). BranchMap therefore uses `git merge-tree --write-tree`, which writes
temporary tree objects into the object database. It never touches refs, the index, or
the working tree, and the objects are unreferenced garbage that `git gc` reclaims.
This is stated in the UI next to every preview result.

### Rules the codebase follows

- **Git runs only in Rust.** Commands are invoked with argument arrays, never shell
  strings, so repository paths and contents can never be interpreted as commands.
- **Read-only.** Every Git call sets `GIT_OPTIONAL_LOCKS=0` and runs only
  `rev-parse`, `status`, `rev-list`, `log`, `for-each-ref`, `merge-base`, `diff`, and
  `merge-tree`. Nothing in this build changes refs, the index, or the working tree,
  and no destructive command (`reset`, `clean`, `push`, `commit`, `merge`, `rebase`,
  checkout) exists.
- **Bounded.** Each Git subprocess has a 10s timeout and capped output; a wedged
  process is killed instead of freezing the UI.
- **Structured errors.** Failures return `{ kind, message, hint }` so the UI can
  explain what to do next.
- **No fake data.** Unimplemented features render explicit empty states. Git facts
  shown to the user always come from a real command.
- **Topological order.** History is read with `--topo-order` so a parent never
  appears above its children — the graph columns depend on this.
- **Diff text is never treated as markup.** Unified diffs are rendered as React text
  nodes only; repository content is untrusted input and is never injected as HTML.

## Troubleshooting

**`error: linker 'link.exe' not found`** — the MSVC build tools are missing or
`cargo` cannot see them. Install the Build Tools workload above, then restart the
terminal.

**Git not detected in the app** — BranchMap calls `git --version` using `PATH`. If
Git works in your terminal but not in the app, launch BranchMap from a shell that
has the same environment.

**Port 1420 already in use** — something already owns the fixed port. Free it, or
change `server.port` in `vite.config.ts` *and* `build.devUrl` in
`src-tauri/tauri.conf.json` together.