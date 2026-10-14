use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Serialize;

mod diag;
mod ollama;

/// Git is invoked locally and read-only. Every call is bounded so a wedged
/// credential helper or an interactive prompt can never freeze the UI thread.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Hard ceiling on captured output. Commits and diffs can be enormous, so we
/// truncate rather than letting a runaway repository exhaust memory.
const OUTPUT_CAPTURE_LIMIT: usize = 4 * 1024 * 1024;

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
  GitNotFound,
  InvalidPath,
  NotARepository,
  Timeout,
  GitFailed,
}

/// Structured, actionable error. `hint` tells the user what to actually do next.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitError {
  pub kind: ErrorKind,
  pub message: String,
  pub hint: Option<String>,
}

impl GitError {
  fn new(kind: ErrorKind, message: impl Into<String>, hint: Option<String>) -> Self {
    Self { kind, message: message.into(), hint }
  }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GitInstallation {
  pub available: bool,
  pub version: Option<String>,
  pub path: Option<String>,
  pub message: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryInfo {
  pub path: String,
  pub name: String,
  pub root: String,
  pub git_dir: String,
  pub has_commits: bool,
  pub current_branch: Option<String>,
  pub detached: bool,
  pub head_sha: Option<String>,
  /// True when the chosen folder was a subdirectory and Git resolved an
  /// ancestor repository instead. Surfaced so the UI can explain the jump
  /// rather than silently opening an unrelated repo.
  pub resolved_from_subdirectory: bool,
  pub clean: bool,
  pub changed_files: usize,
  pub untracked_files: usize,
}

/// One commit as read from Git. Every field comes from the object database —
/// nothing here is synthesised by BranchMap.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
  pub hash: String,
  pub short_hash: String,
  pub subject: String,
  pub author_name: String,
  pub author_email: String,
  /// Author date as Unix seconds.
  pub authored_at: i64,
  /// Parent hashes in Git order; the first is the mainline parent.
  pub parents: Vec<String>,
  /// Refs pointing at this commit, e.g. "HEAD -> main", "origin/main", "tag: v1.0".
  pub decorations: Vec<String>,
  pub is_merge: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitPage {
  pub commits: Vec<Commit>,
  /// Total commits reachable from HEAD, used for pagination.
  pub total: usize,
  pub has_more: bool,
  /// True for shallow clones, where history is intentionally incomplete.
  pub shallow: bool,
  /// True when output hit the capture ceiling, so older commits are missing.
  pub truncated: bool,
}

/// Field separator (ASCII 0x1F) and record separator (ASCII 0x1E) keep parsing
/// stable even when a subject contains spaces, commas, or other punctuation.
const LOG_FORMAT: &str = "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s%x1e";
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;

/// Reads real commit history. Read-only: runs `log` / `rev-list` / `rev-parse` only.
#[tauri::command]
fn list_commits(
  path: String,
  limit: Option<usize>,
  skip: Option<usize>,
) -> Result<CommitPage, GitError> {
  let dir = ensure_repository(&path)?;

  let shallow = run_git(Some(&dir), &["rev-parse", "--is-shallow-repository"])
    .map(|o| o.stdout.trim() == "true")
    .unwrap_or(false);

  // An unborn HEAD is a valid repository with nothing to show, not an error.
  let has_head = run_git(Some(&dir), &["rev-parse", "--verify", "HEAD"])
    .map(|o| o.status == 0)
    .unwrap_or(false);

  if !has_head {
    return Ok(CommitPage {
      commits: Vec::new(),
      total: 0,
      has_more: false,
      shallow,
      truncated: false,
    });
  }

  let total = run_git(Some(&dir), &["rev-list", "--count", "HEAD"])
    .ok()
    .filter(|o| o.status == 0)
    .and_then(|o| o.stdout.trim().parse::<usize>().ok())
    .unwrap_or(0);

  let limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
  let skip = skip.unwrap_or(0).min(1_000_000);

  let max_count = limit.to_string();
  let skip_count = skip.to_string();
  let out = run_git(
    Some(&dir),
    &[
      "log",
      // Topological order guarantees a parent never appears above its children,
      // which is what makes a lane-based graph renderable.
      "--topo-order",
      "--max-count",
      &max_count,
      "--skip",
      &skip_count,
      LOG_FORMAT,
      "HEAD",
    ],
  )?;

  if out.status != 0 {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      out.stderr.trim().to_string(),
      Some("The repository could not be read. It may be corrupt or locked.".into()),
    ));
  }

  // Reaching the capture ceiling means older commits are genuinely missing;
  // report it rather than silently presenting a partial history as complete.
  let truncated = out.stdout.len() >= OUTPUT_CAPTURE_LIMIT;
  let commits = parse_log_output(&out.stdout);

  Ok(CommitPage {
    has_more: skip + commits.len() < total,
    commits,
    total,
    shallow,
    truncated,
  })
}

/// Turns `git log` output produced with [`LOG_FORMAT`] into commits.
/// Split out from the command so it can be tested against real Git output.
fn parse_log_output(stdout: &str) -> Vec<Commit> {
  let mut commits = Vec::new();

  for record in stdout.split('\u{1e}') {
    // Git appends a newline after every record, so the separator lands at the
    // start of the following record.
    let record = record.trim();
    if record.is_empty() {
      continue;
    }

    let fields: Vec<&str> = record.split('\u{1f}').collect();
    if fields.len() < 8 {
      continue;
    }

    let parents: Vec<String> = fields[5].split_whitespace().map(str::to_string).collect();
    let decorations: Vec<String> = fields[6]
      .split(',')
      .map(|d| d.trim().to_string())
      .filter(|d| !d.is_empty())
      .collect();

    commits.push(Commit {
      hash: fields[0].trim().to_string(),
      short_hash: fields[1].trim().to_string(),
      author_name: fields[2].to_string(),
      author_email: fields[3].to_string(),
      authored_at: fields[4].trim().parse().unwrap_or(0),
      is_merge: parents.len() > 1,
      parents,
      decorations,
      subject: fields[7].to_string(),
    });
  }

  commits
}

// ── Branch comparison ────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
  pub name: String,
  pub commit: String,
  pub is_head: bool,
  pub upstream: Option<String>,
  pub subject: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct BranchList {
  pub branches: Vec<BranchInfo>,
  /// Checked-out branch, absent when HEAD is detached.
  pub head: Option<String>,
  pub detached: bool,
  pub has_commits: bool,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "camelCase")]
pub enum FileStatus {
  Added,
  Modified,
  Deleted,
  Renamed,
  Copied,
  TypeChanged,
  Unmerged,
  Unknown,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
  /// Path after the change (the new path for renames and copies).
  pub path: String,
  pub old_path: Option<String>,
  pub status: FileStatus,
  /// `None` for binary files, where Git reports no line counts.
  pub insertions: Option<usize>,
  pub deletions: Option<usize>,
  pub binary: bool,
  /// Modified on both sides relative to the merge base. This is an overlap
  /// indicator, **not** a confirmed conflict.
  pub overlap: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffTotals {
  pub files: usize,
  pub insertions: usize,
  pub deletions: usize,
  pub binary_files: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Comparison {
  pub base: String,
  pub compare: String,
  /// `mergeBase` uses `base...compare` (from the merge base); `direct` uses
  /// `base compare` (tip to tip).
  pub mode: String,
  pub base_sha: String,
  pub compare_sha: String,
  pub merge_base: Option<String>,
  pub merge_base_subject: Option<String>,
  /// Commits reachable from `compare` but not `base` — `git log base..compare`.
  pub ahead: usize,
  /// Commits reachable from `base` but not `compare`.
  pub behind: usize,
  pub commits: Vec<Commit>,
  pub commits_truncated: bool,
  pub files: Vec<FileChange>,
  pub files_truncated: bool,
  pub totals: DiffTotals,
  pub overlap_count: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
  pub path: String,
  pub binary: bool,
  pub truncated: bool,
  pub diff: String,
  pub additions: usize,
  pub deletions: usize,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergePreview {
  pub supported: bool,
  pub clean: bool,
  pub conflicts: Vec<String>,
  /// Merge tree object id reported by `git merge-tree`.
  pub tree: Option<String>,
  pub message: String,
}

/// `for-each-ref` does **not** expand the `%xNN` escapes that `git log --format`
/// supports, so fields use a literal `|`. Branch and upstream names cannot
/// contain `|`, but a commit subject can — hence `splitn(5, ...)` below, which
/// keeps everything after the fourth separator as the subject.
const REF_FORMAT: &str =
  "--format=%(refname:short)|%(objectname)|%(HEAD)|%(upstream:short)|%(contents:subject)";
const MAX_DIFF_BYTES: usize = 512 * 1024;
const MAX_REPORT_BYTES: usize = 4 * 1024 * 1024;
const MAX_COMMIT_LIST: usize = 500;

// ── Per-commit changes ───────────────────────────────────────────────────────

/// Git's canonical empty tree. Diffing a root commit against it shows every file
/// the commit introduced, without needing a parent that does not exist.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitChanges {
  pub commit: String,
  pub short_hash: String,
  pub subject: String,
  pub parents: Vec<String>,
  pub is_merge: bool,
  pub is_root: bool,
  /// `firstParent` compares against the first parent; `combined` lists only
  /// files that differ from *every* parent.
  pub mode: String,
  /// Human-readable description of what the file list actually represents.
  pub comparison: String,
  pub files: Vec<FileChange>,
  pub totals: DiffTotals,
  pub truncated: bool,
  /// False in combined mode, where Git reports no line counts.
  pub stats_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WrittenFile {
  pub path: String,
  pub bytes: usize,
}

struct GitOutput {
  status: i32,
  stdout: String,
  stderr: String,
}

/// Suppresses the console window that Windows would otherwise allocate for
/// every child process.
///
/// The release build uses the `windows` subsystem, so it has no console of its
/// own. Spawning a console program such as `git.exe` without this flag makes
/// Windows create a visible console window for that child's lifetime — which
/// appears to the user as a flash on every Git call.
#[cfg(windows)]
pub(crate) fn hide_console(command: &mut Command) {
  use std::os::windows::process::CommandExt;
  /// CREATE_NO_WINDOW — run the child without a console window.
  const CREATE_NO_WINDOW: u32 = 0x0800_0000;
  command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
pub(crate) fn hide_console(_command: &mut Command) {}

/// Runs `git` with an explicit argument array — never a shell string, so paths
/// and repository contents can never be interpreted as a command.
fn run_git(dir: Option<&Path>, args: &[&str]) -> Result<GitOutput, GitError> {
  let mut cmd = Command::new("git");
  hide_console(&mut cmd);
  cmd.arg("--no-pager").args(args);

  if let Some(dir) = dir {
    cmd.current_dir(dir);
  }

  cmd
    // `GIT_OPTIONAL_LOCKS=0` keeps index refresh from writing to `.git` during a
    // read, so inspecting a repository never touches its on-disk state.
    .env("GIT_OPTIONAL_LOCKS", "0")
    // Fail fast instead of blocking on a credential/username prompt.
    .env("GIT_TERMINAL_PROMPT", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = cmd.spawn().map_err(|e| {
    if e.kind() == std::io::ErrorKind::NotFound {
      GitError::new(
        ErrorKind::GitNotFound,
        "Git was not found on PATH.",
        Some("Install Git for Windows from https://git-scm.com/download/win and reopen BranchMap.".into()),
      )
    } else {
      GitError::new(ErrorKind::GitFailed, format!("Failed to start Git: {e}"), None)
    }
  })?;

  // Drain both pipes on separate threads: if we waited for exit before reading,
  // a repository with enough output to fill the OS pipe buffer would deadlock.
  let mut stdout_pipe = child.stdout.take();
  let mut stderr_pipe = child.stderr.take();
  let stdout_handle = std::thread::spawn(move || read_capped(&mut stdout_pipe));
  let stderr_handle = std::thread::spawn(move || read_capped(&mut stderr_pipe));

  let started = Instant::now();
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) => {
        if started.elapsed() > GIT_TIMEOUT {
          let _ = child.kill();
          let _ = child.wait();
          return Err(GitError::new(
            ErrorKind::Timeout,
            format!("Git did not respond within {} seconds.", GIT_TIMEOUT.as_secs()),
            Some("The repository may be on a slow or disconnected network drive.".into()),
          ));
        }
        std::thread::sleep(Duration::from_millis(20));
      }
      Err(e) => {
        return Err(GitError::new(ErrorKind::GitFailed, format!("Git process error: {e}"), None));
      }
    }
  };

  let stdout = stdout_handle.join().unwrap_or_default();
  let stderr = stderr_handle.join().unwrap_or_default();

  Ok(GitOutput {
    status: status.code().unwrap_or(-1),
    stdout,
    stderr,
  })
}

fn read_capped(pipe: &mut Option<impl Read>) -> String {
  let Some(pipe) = pipe.as_mut() else { return String::new() };
  let mut buf = Vec::new();
  let mut chunk = [0u8; 8192];
  loop {
    match pipe.read(&mut chunk) {
      Ok(0) | Err(_) => break,
      Ok(n) => {
        if buf.len() < OUTPUT_CAPTURE_LIMIT {
          let room = OUTPUT_CAPTURE_LIMIT.saturating_sub(buf.len());
          buf.extend_from_slice(&chunk[..n.min(room)]);
        }
      }
    }
  }
  String::from_utf8_lossy(&buf).to_string()
}

/// Reports whether Git is installed and which version, without touching any repo.
#[tauri::command]
fn check_git_installation() -> GitInstallation {
  match run_git(None, &["--version"]) {
    Ok(out) if out.status == 0 => {
      let version = out.stdout.trim().trim_start_matches("git version ").to_string();
      let path = which_git();
      GitInstallation {
        available: true,
        version: Some(version),
        path,
        message: None,
      }
    }
    Ok(out) => GitInstallation {
      available: false,
      version: None,
      path: None,
      message: Some(out.stderr.trim().to_string()),
    },
    Err(err) => GitInstallation {
      available: false,
      version: None,
      path: None,
      message: Some(err.message),
    },
  }
}

fn which_git() -> Option<String> {
  let mut command = Command::new("where");
  hide_console(&mut command);
  let output = command.arg("git").output().ok()?;
  if !output.status.success() {
    return None;
  }
  output
    .stdout
    .split(|b| *b == b'\r' || *b == b'\n')
    .map(|b| String::from_utf8_lossy(b).trim().to_string())
    .find(|s| !s.is_empty())
}

/// Validates that `path` is a readable Git working tree and returns the directory
/// Git should run in. Shared by every repository-scoped command so path handling
/// and error wording stay identical.
fn ensure_repository(path: &str) -> Result<PathBuf, GitError> {
  let trimmed = path.trim();
  if trimmed.is_empty() {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      "No repository path was provided.",
      Some("Choose a folder that contains a .git directory.".into()),
    ));
  }

  let dir = PathBuf::from(trimmed);
  if !dir.exists() {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      format!("{} does not exist.", dir.display()),
      Some("Check the path — BranchMap reads local folders only.".into()),
    ));
  }
  if !dir.is_dir() {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      format!("{} is a file, not a folder.", dir.display()),
      Some("Select the repository's root folder instead.".into()),
    ));
  }

  let inside = run_git(Some(&dir), &["rev-parse", "--is-inside-work-tree"])?;
  if inside.status != 0 || inside.stdout.trim() != "true" {
    return Err(GitError::new(
      ErrorKind::NotARepository,
      format!("{} is not a Git working tree.", dir.display()),
      Some("Select a folder containing a .git directory.".into()),
    ));
  }

  Ok(dir)
}

/// Validates that `path` is a readable Git working tree and returns real metadata.
/// Read-only: runs `rev-parse` / `status` only, and never writes to the repository.
#[tauri::command]
fn validate_repository(path: String) -> Result<RepositoryInfo, GitError> {
  let dir = ensure_repository(&path)?;

  let root = run_git(Some(&dir), &["rev-parse", "--show-toplevel"])?;
  let root_path = root.stdout.trim().to_string();
  let git_dir = run_git(Some(&dir), &["rev-parse", "--absolute-git-dir"])?;

  // An unborn HEAD (no commits yet) is a valid repo, so this failure is expected
  // rather than fatal.
  let head_sha = match run_git(Some(&dir), &["rev-parse", "--verify", "HEAD"]) {
    Ok(out) if out.status == 0 => Some(out.stdout.trim().to_string()),
    _ => None,
  };
  let has_commits = head_sha.is_some();

  let branch_ref = run_git(Some(&dir), &["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let (current_branch, detached) = match branch_ref {
    Ok(out) if out.status == 0 => (Some(out.stdout.trim().to_string()), false),
    _ => (None, has_commits),
  };

  // `--porcelain` gives one stable, script-friendly line per changed path.
  let status = run_git(Some(&dir), &["status", "--porcelain=v1"])?;
  let mut changed_files = 0usize;
  let mut untracked_files = 0usize;
  for line in status.stdout.lines().filter(|l| !l.trim().is_empty()) {
    if line.starts_with("??") {
      untracked_files += 1;
    } else {
      changed_files += 1;
    }
  }

  let root_for_name = if root_path.is_empty() { dir.clone() } else { PathBuf::from(&root_path) };

  // `git rev-parse` walks upward, so picking any nested folder (or one that
  // merely sits inside an accidental parent repo) resolves to an ancestor.
  // Canonicalize both sides before comparing: Git reports forward slashes,
  // so a raw string compare would always differ.
  let selected_canon = std::fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
  let root_canon = std::fs::canonicalize(&root_for_name).unwrap_or_else(|_| root_for_name.clone());
  let resolved_from_subdirectory = selected_canon != root_canon;

  let name = root_for_name
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| root_for_name.to_string_lossy().to_string());

  Ok(RepositoryInfo {
    path: dir.to_string_lossy().to_string(),
    name,
    root: if root_path.is_empty() { dir.to_string_lossy().to_string() } else { root_path },
    git_dir: git_dir.stdout.trim().to_string(),
    has_commits,
    current_branch,
    detached,
    head_sha,
    resolved_from_subdirectory,
    clean: changed_files == 0 && untracked_files == 0,
    changed_files,
    untracked_files,
  })
}

/// Real branches from `for-each-ref`, newest first. Read-only.
#[tauri::command]
fn list_branches(path: String) -> Result<BranchList, GitError> {
  let dir = ensure_repository(&path)?;

  let has_commits = run_git(Some(&dir), &["rev-parse", "--verify", "HEAD"])
    .map(|o| o.status == 0)
    .unwrap_or(false);

  // Option flags must precede the ref pattern: `for-each-ref` stops parsing
// options at the first non-option argument.
  let out = run_git(
    Some(&dir),
    &["for-each-ref", "--sort=-committerdate", REF_FORMAT, "refs/heads/"],
  )?;

  if out.status != 0 {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      out.stderr.trim().to_string(),
      Some("The branch list could not be read.".into()),
    ));
  }

  let mut branches = Vec::new();
  for line in out.stdout.lines() {
    if line.trim().is_empty() {
      continue;
    }
    // Only the first four separators are structural; a subject may contain `|`.
    let f: Vec<&str> = line.splitn(5, '|').collect();
    if f.len() < 5 {
      continue;
    }
    branches.push(BranchInfo {
      name: f[0].to_string(),
      commit: f[1].trim().to_string(),
      is_head: f[2].trim() == "*",
      upstream: (!f[3].trim().is_empty()).then(|| f[3].to_string()),
      subject: f[4].to_string(),
    });
  }

  let branch_ref = run_git(Some(&dir), &["symbolic-ref", "--quiet", "--short", "HEAD"]);
  let head = match branch_ref {
    Ok(r) if r.status == 0 => Some(r.stdout.trim().to_string()),
    _ => None,
  };

  let detached = head.is_none();
  Ok(BranchList { branches, head, detached, has_commits })
}

/// Resolves a user-supplied revision to a commit id, rejecting anything that
/// could be read as an option. Read-only.
fn resolve_commit(dir: &Path, rev: &str) -> Result<String, GitError> {
  let rev = rev.trim();
  if rev.is_empty() {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      "A branch name was empty.",
      Some("Pick a branch from the list.".into()),
    ));
  }
  if rev.starts_with('-') {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      format!("{rev} is not a valid branch name."),
      Some("Pick a branch from the list.".into()),
    ));
  }

  let spec = format!("{rev}^{{commit}}");
  let out = run_git(Some(dir), &["rev-parse", "--verify", "--quiet", "--end-of-options", &spec])?;

  if out.status != 0 || out.stdout.trim().is_empty() {
    return Err(GitError::new(
      ErrorKind::NotARepository,
      format!("Branch '{rev}' was not found in this repository."),
      Some("It may have been deleted, or this may be a shallow clone without it.".into()),
    ));
  }

  Ok(out.stdout.trim().to_string())
}

/// Builds the two-dot or three-dot revision pair for a comparison.
fn diff_args(base: &str, compare: &str, mode: &str) -> Vec<String> {
  if mode == "direct" {
    vec![base.to_string(), compare.to_string()]
  } else {
    vec![format!("{base}...{compare}")]
  }
}

/// Full comparison between two branches. Read-only: `merge-base`, `rev-list`,
/// `log`, and `diff` only.
#[tauri::command]
fn compare_branches(
  path: String,
  base: String,
  compare: String,
  mode: Option<String>,
  limit: Option<usize>,
) -> Result<Comparison, GitError> {
  let dir = ensure_repository(&path)?;
  let mode = mode.unwrap_or_else(|| "mergeBase".to_string());
  let normalized_mode = if mode == "direct" { "direct" } else { "mergeBase" }.to_string();

  let base_sha = resolve_commit(&dir, &base)?;
  let compare_sha = resolve_commit(&dir, &compare)?;

  let merge_base = run_git(Some(&dir), &["merge-base", &base_sha, &compare_sha])
    .ok()
    .filter(|o| o.status == 0)
    .map(|o| o.stdout.trim().to_string())
    .filter(|s| !s.is_empty());

  let merge_base_subject = merge_base.as_ref().and_then(|mb| {
    run_git(Some(&dir), &["log", "-1", "--format=%s", mb])
      .ok()
      .filter(|o| o.status == 0)
      .map(|o| o.stdout.trim().to_string())
  });

  // `base...compare` counts commits on each side of the symmetric difference.
  let (behind, ahead) = run_git(
    Some(&dir),
    &["rev-list", "--left-right", "--count", &format!("{base_sha}...{compare_sha}")],
  )
  .ok()
  .filter(|o| o.status == 0)
  .and_then(|o| {
    let mut parts = o.stdout.split_whitespace();
    Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
  })
  .unwrap_or((0, 0));

  // Commits are always `base..compare`: reachable from compare but not base.
  // This is independent of the diff mode chosen above.
  let max_commits = limit.unwrap_or(MAX_COMMIT_LIST).clamp(1, MAX_COMMIT_LIST);
  let max_count = max_commits.to_string();
  // `LOG_FORMAT` already carries the `--format=` prefix and must be passed as a
  // single argument — `git log --format <value>` makes Git read the value as a
  // revision and fail with "ambiguous argument".
  let log_out = run_git(
    Some(&dir),
    &[
      "log",
      "--topo-order",
      "--max-count",
      &max_count,
      LOG_FORMAT,
      &format!("{base_sha}..{compare_sha}"),
    ],
  )?;

  let commits = if log_out.status == 0 { parse_log_output(&log_out.stdout) } else { Vec::new() };

  let range = diff_args(&base_sha, &compare_sha, &normalized_mode);
  let range_refs: Vec<&str> = range.iter().map(String::as_str).collect();

  let (files, totals, files_truncated) = diff_summary(&dir, &range_refs);

  // Overlap: paths changed on each side since the merge base. This is an
  // indicator of edit collision, never proof of a merge conflict.
  let (overlap_paths, overlap_count) = match &merge_base {
    Some(mb) => {
      let base_side = changed_paths(&dir, &[mb.as_str(), base_sha.as_str()]);
      let compare_side = changed_paths(&dir, &[mb.as_str(), compare_sha.as_str()]);
      let overlap: Vec<String> = compare_side
        .iter()
        .filter(|p| base_side.contains(p))
        .cloned()
        .collect();
      let count = overlap.len();
      (overlap, count)
    }
    None => (Vec::new(), 0),
  };

  let files: Vec<FileChange> = files
    .into_iter()
    .map(|mut f| {
      f.overlap = overlap_paths.iter().any(|p| p == &f.path || Some(p) == f.old_path.as_ref());
      f
    })
    .collect();

  Ok(Comparison {
    base: base.clone(),
    compare: compare.clone(),
    mode: normalized_mode,
    base_sha,
    compare_sha,
    merge_base,
    merge_base_subject,
    ahead,
    behind,
    commits,
    commits_truncated: false,
    files,
    files_truncated,
    totals,
    overlap_count,
  })
}

/// File-level status and line counts for a revision pair.
fn diff_summary(dir: &Path, range: &[&str]) -> (Vec<FileChange>, DiffTotals, bool) {
  let mut args = vec!["diff", "--find-renames", "--find-copies", "--numstat", "-z"];
  args.extend_from_slice(range);
  let numstat = run_git(Some(dir), &args).ok().filter(|o| o.status == 0);
  let truncated = numstat.as_ref().is_some_and(|o| o.stdout.len() >= OUTPUT_CAPTURE_LIMIT);
  let numstat_text = numstat.map(|o| o.stdout).unwrap_or_default();

  let mut args = vec!["diff", "--find-renames", "--find-copies", "--name-status", "-z"];
  args.extend_from_slice(range);
  let name_status = run_git(Some(dir), &args).ok().filter(|o| o.status == 0);
  let statuses_text = name_status.map(|o| o.stdout).unwrap_or_default();

  let statuses = parse_name_status(&statuses_text);
  let counts = parse_numstat(&numstat_text);

  let mut files: Vec<FileChange> = Vec::new();
  let mut totals = DiffTotals { files: 0, insertions: 0, deletions: 0, binary_files: 0 };

  for (status, path, old_path) in statuses {
    let key = counts.iter().find(|c| c.2 == path || Some(&c.2) == old_path.as_ref());
    let binary = key.is_none_or(|c| c.0.is_none() || c.1.is_none());

    let insertions = key.and_then(|c| c.0);
    let deletions = key.and_then(|c| c.1);

    if binary {
      totals.binary_files += 1;
    } else {
      totals.insertions += insertions.unwrap_or(0);
      totals.deletions += deletions.unwrap_or(0);
    }
    totals.files += 1;

    files.push(FileChange {
      path,
      old_path,
      status,
      insertions: if binary { None } else { insertions },
      deletions: if binary { None } else { deletions },
      binary,
      overlap: false,
    });
  }

  (files, totals, truncated)
}

/// Paths changed between two revisions, used for overlap detection.
fn changed_paths(dir: &Path, range: &[&str]) -> Vec<String> {
  let mut args = vec!["diff", "--name-only", "-z"];
  args.extend_from_slice(range);
  match run_git(Some(dir), &args) {
    Ok(o) if o.status == 0 => o.stdout.split('\0').filter(|s| !s.is_empty()).map(str::to_string).collect(),
    _ => Vec::new(),
  }
}

/// Parses `--name-status -z`. Rename and copy records carry two paths.
fn parse_name_status(text: &str) -> Vec<(FileStatus, String, Option<String>)> {
  let tokens: Vec<&str> = text.split('\0').collect();
  let mut out = Vec::new();
  let mut i = 0;

  while i < tokens.len() {
    let code = tokens[i].trim();
    if code.is_empty() {
      i += 1;
      continue;
    }

    let letter = code.chars().next().unwrap_or('?');
    let two_paths = matches!(letter, 'R' | 'C');

    if i + 1 >= tokens.len() {
      break;
    }
    let first = tokens[i + 1].to_string();

    // A status with no path means the stream was truncated; stop rather than
    // inventing an empty entry.
    if first.is_empty() {
      break;
    }

    if two_paths && i + 2 < tokens.len() && !tokens[i + 2].is_empty() {
      out.push((status_from_letter(letter), tokens[i + 2].to_string(), Some(first)));
      i += 3;
    } else {
      out.push((status_from_letter(letter), first, None));
      i += 2;
    }
  }

  out
}

fn status_from_letter(letter: char) -> FileStatus {
  match letter {
    'A' => FileStatus::Added,
    'M' => FileStatus::Modified,
    'D' => FileStatus::Deleted,
    'R' => FileStatus::Renamed,
    'C' => FileStatus::Copied,
    'T' => FileStatus::TypeChanged,
    'U' => FileStatus::Unmerged,
    _ => FileStatus::Unknown,
  }
}

/// Parses `--numstat -z` into `(insertions, deletions, path)`. Binary files
/// report `-` and yield `None`. A rename record has an empty path field
/// followed by the old and new paths.
fn parse_numstat(text: &str) -> Vec<(Option<usize>, Option<usize>, String)> {
  let tokens: Vec<&str> = text.split('\0').collect();
  let mut out = Vec::new();
  let mut i = 0;

  while i < tokens.len() {
    let token = tokens[i];
    if token.is_empty() {
      i += 1;
      continue;
    }

    // Git separates these fields with a TAB, not a control character.
    let mut parts = token.split('\t');
    let ins = parts.next().unwrap_or("");
    let del = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");

    // Fewer than two tabs means this is not a numstat record; skip it instead
    // of parsing the whole token as a number.
    if !token.contains('\t') {
      i += 1;
      continue;
    }

    let parse = |v: &str| -> Option<usize> {
      if v == "-" {
        None
      } else {
        v.parse().ok()
      }
    };

    if path.is_empty() {
      // Rename/copy: the next two NUL-separated tokens are old and new paths.
      if i + 2 < tokens.len() {
        out.push((parse(ins), parse(del), tokens[i + 2].to_string()));
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }

    out.push((parse(ins), parse(del), path.to_string()));
    i += 1;
  }

  out
}

/// Unified diff for a single path. Read-only, size-capped, and repository text
/// Builds a unified diff for one path within a revision pair. Shared by branch
/// comparisons and per-commit views so limits and binary handling stay identical.
///
/// The returned text is raw Git output; callers must render it as data, never markup.
fn build_file_diff(dir: &Path, range: &[&str], file: &str) -> Result<FileDiff, GitError> {
  let numstat = run_git(
    Some(&dir),
    &{
      let mut a = vec!["diff", "--find-renames", "--numstat", "-z"];
      a.extend_from_slice(range);
      a.push("--");
      a.push(file);
      a
    },
  )
  .ok()
  .filter(|o| o.status == 0);

  let binary = numstat
    .as_ref()
    .map(|o| parse_numstat(&o.stdout).first().is_none_or(|c| c.0.is_none() || c.1.is_none()))
    .unwrap_or(false);

  let diff_out = run_git(
    Some(&dir),
    &{
      let mut a = vec!["diff", "--find-renames", "--unified=3", "--no-color"];
      a.extend_from_slice(range);
      // `--` stops the path from being parsed as an option.
      a.push("--");
      a.push(file);
      a
    },
  )?;

  if diff_out.status != 0 && diff_out.status != 1 {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      diff_out.stderr.trim().to_string(),
      Some("The diff for this file could not be generated.".into()),
    ));
  }

  let truncated = diff_out.stdout.len() > MAX_DIFF_BYTES;
  let mut diff = diff_out.stdout;
  if truncated {
    // Clip on a character boundary so the text stays valid UTF-8.
    let mut end = MAX_DIFF_BYTES;
    while end > 0 && !diff.is_char_boundary(end) {
      end -= 1;
    }
    diff.truncate(end);
  }

  let mut additions = 0usize;
  let mut deletions = 0usize;
  for line in diff.lines() {
    if line.starts_with('+') && !line.starts_with("+++") {
      additions += 1;
    } else if line.starts_with('-') && !line.starts_with("---") {
      deletions += 1;
    }
  }

  Ok(FileDiff { path: file.to_string(), binary, truncated, diff, additions, deletions })
}

/// Unified diff for a single path between two revisions.
///
/// Read-only, size-capped, and repository text is returned verbatim as data —
/// the frontend renders it as text, never HTML.
#[tauri::command]
fn get_file_diff(
  path: String,
  base: String,
  compare: String,
  file: String,
  mode: Option<String>,
) -> Result<FileDiff, GitError> {
  let dir = ensure_repository(&path)?;
  let base_sha = resolve_commit(&dir, &base)?;
  let compare_sha = resolve_commit(&dir, &compare)?;

  let range = diff_args(&base_sha, &compare_sha, &mode.unwrap_or_default());
  let range_refs: Vec<&str> = range.iter().map(String::as_str).collect();
  build_file_diff(&dir, &range_refs, &file)
}

/// Read-only merge preview via `git merge-tree`.
///
/// Note: the modern `--write-tree` form writes temporary tree objects into the
/// object database. It never touches refs, the index, or the working tree, and
/// the objects are unreferenced garbage. The legacy read-only form no longer
/// exists in Git 2.50+.
#[tauri::command]
fn preview_merge(path: String, base: String, compare: String) -> Result<MergePreview, GitError> {
  let dir = ensure_repository(&path)?;
  let base_sha = resolve_commit(&dir, &base)?;
  let compare_sha = resolve_commit(&dir, &compare)?;

  let out = run_git(
    Some(&dir),
    &["merge-tree", "--write-tree", "--name-only", &base_sha, &compare_sha],
  )?;

  // Exit 0 = clean merge, 1 = conflicts. Anything else is a usage error.
  if out.status != 0 && out.status != 1 {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      out.stderr.trim().to_string(),
      Some("This Git version could not produce a merge preview.".into()),
    ));
  }

  let mut lines = out.stdout.lines();
  let tree = lines.next().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);

  let mut conflicts: Vec<String> = Vec::new();
  for line in lines.by_ref() {
    if line.trim().is_empty() {
      break;
    }
    conflicts.push(line.to_string());
  }

  let clean = out.status == 0;
  let message = if clean {
    "Git reports no conflicts for this merge. This is an estimate, not a guarantee."
      .to_string()
  } else {
    format!(
      "Git reports {} conflicting path(s). This is an estimate: overlapping edits do not always conflict, and the preview cannot predict later changes.",
      conflicts.len()
    )
  };

  Ok(MergePreview { supported: true, clean, conflicts, tree, message })
}

/// Parents of a single commit, via `rev-list --parents`.
fn commit_parents(dir: &Path, sha: &str) -> Vec<String> {
  run_git(Some(dir), &["rev-list", "--parents", "-n", "1", sha])
    .ok()
    .filter(|o| o.status == 0)
    .map(|o| {
      o.stdout
        .split_whitespace()
        .skip(1)
        .map(str::to_string)
        .collect()
    })
    .unwrap_or_default()
}

/// Files changed by a single commit. Read-only.
///
/// Merge commits are deliberately explicit: `firstParent` shows what the merge
/// brought in relative to the mainline, while `combined` lists only files that
/// differ from *every* parent (conflict resolutions). Neither is presented as
/// "the" result of the merge without saying which one it is.
#[tauri::command]
fn get_commit_changes(
  path: String,
  commit: String,
  mode: Option<String>,
) -> Result<CommitChanges, GitError> {
  let dir = ensure_repository(&path)?;
  let sha = resolve_commit(&dir, &commit)?;
  let parents = commit_parents(&dir, &sha);
  let is_root = parents.is_empty();
  let is_merge = parents.len() > 1;
  let mode = if mode.as_deref() == Some("combined") { "combined" } else { "firstParent" };

  let meta = run_git(Some(&dir), &["log", "-1", "--format=%h%x1f%s", &sha])
    .ok()
    .filter(|o| o.status == 0)
    .map(|o| {
      let mut parts = o.stdout.trim().splitn(2, '\u{1f}');
      (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string())
    })
    .unwrap_or_else(|| (sha.chars().take(7).collect(), String::new()));

  // A combined diff only exists for a merge; anything else falls back to the
  // first-parent view rather than pretending combined semantics apply.
  let use_combined = mode == "combined" && is_merge;

  let (files, totals, truncated, stats_available, comparison) = if use_combined {
    let out = run_git(
      Some(&dir),
      &["diff-tree", "-c", "--no-commit-id", "-r", "--name-status", "-z", &sha],
    )
    .ok()
    .filter(|o| o.status == 0);

    let truncated = out.as_ref().is_some_and(|o| o.stdout.len() >= OUTPUT_CAPTURE_LIMIT);
    let text = out.map(|o| o.stdout).unwrap_or_default();

    let files: Vec<FileChange> = parse_name_status(&text)
      .into_iter()
      .map(|(status, path, old_path)| FileChange {
        path,
        old_path,
        status,
        // Combined diffs report no per-file line counts.
        insertions: None,
        deletions: None,
        binary: false,
        overlap: false,
      })
      .collect();

    let total = DiffTotals {
      files: files.len(),
      insertions: 0,
      deletions: 0,
      binary_files: 0,
    };

    (
      files,
      total,
      truncated,
      false,
      "Combined diff: files that differ from every parent (merge resolutions only). \
       Line statistics are not reported for combined diffs."
        .to_string(),
    )
  } else {
    let reference = if is_root { EMPTY_TREE.to_string() } else { parents[0].clone() };
    let (files, totals, truncated) = diff_summary(&dir, &[reference.as_str(), sha.as_str()]);

    let comparison = if is_root {
      format!(
        "Against the empty tree — every file this root commit introduced ({reference})."
      )
    } else if is_merge {
      format!(
        "Against the first parent only ({}). A merge also has {} parent(s); this view does not describe the whole merge result.",
        &parents[0][..7.min(parents[0].len())],
        parents.len()
      )
    } else {
      format!("Against its parent ({}).", &parents[0][..7.min(parents[0].len())])
    };

    (files, totals, truncated, true, comparison)
  };

  Ok(CommitChanges {
    commit: sha,
    short_hash: meta.0,
    subject: meta.1,
    parents,
    is_merge,
    is_root,
    mode: if use_combined { "combined".to_string() } else { "firstParent".to_string() },
    comparison,
    files,
    totals,
    truncated,
    stats_available,
  })
}

/// Unified diff for one path inside a single commit. Read-only.
#[tauri::command]
fn get_commit_diff(
  path: String,
  commit: String,
  file: String,
  mode: Option<String>,
) -> Result<FileDiff, GitError> {
  let dir = ensure_repository(&path)?;
  let sha = resolve_commit(&dir, &commit)?;
  let parents = commit_parents(&dir, &sha);

  if mode.as_deref() == Some("combined") && parents.len() > 1 {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      "Git does not produce a per-file unified diff for a combined merge diff.",
      Some("Switch to the first-parent view to inspect this file.".into()),
    ));
  }

  // A root commit has no parent, so its reference point is the empty tree.
  let reference = if parents.is_empty() { EMPTY_TREE.to_string() } else { parents[0].clone() };
  build_file_diff(&dir, &[reference.as_str(), sha.as_str()], &file)
}

/// Writes a user-chosen export file. This is the only command that writes to
/// disk. It is reached through the native save dialog and the payload is capped
/// so a runaway report cannot fill the disk.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<WrittenFile, GitError> {
  let target = path.trim();
  if target.is_empty() {
    return Err(GitError::new(
      ErrorKind::InvalidPath,
      "No destination was chosen.",
      Some("Pick a location in the save dialog.".into()),
    ));
  }

  if contents.len() > MAX_REPORT_BYTES {
    return Err(GitError::new(
      ErrorKind::GitFailed,
      format!("The report is too large to save ({} bytes).", contents.len()),
      Some("Narrow the comparison and try again.".into()),
    ));
  }

  let target_path = PathBuf::from(target);
  if let Some(parent) = target_path.parent() {
    if !parent.exists() {
      return Err(GitError::new(
        ErrorKind::InvalidPath,
        format!("{} does not exist.", parent.display()),
        Some("Choose an existing folder.".into()),
      ));
    }
  }

  std::fs::write(&target_path, contents.as_bytes()).map_err(|e| {
    GitError::new(
      ErrorKind::GitFailed,
      format!("Could not write {}: {e}", target_path.display()),
      Some("The file may be open in another program or read-only.".into()),
    )
  })?;

  Ok(WrittenFile { path: target_path.to_string_lossy().to_string(), bytes: contents.len() })
}

#[cfg(test)]
mod tests {
  use super::*;

  /// Real output captured from `git log --max-count=4` on a repository with
  /// merge commits: HEAD -> dev-paul with refs, then two merge commits whose
  /// decorations field is legitimately empty.
  const REAL_LOG: &str = concat!(
    "c3f8dab4109ec5a611cb5a137226c337a1f590ed\u{1f}c3f8dab\u{1f}Polstuds27\u{1f}",
    "paul.mojal@gmail.com\u{1f}1791986635\u{1f}27545321bbb5b5adf281deded8f09c0b9ba6b61d\u{1f}",
    "HEAD -> dev-paul, origin/dev-paul\u{1f}update: excluded archived tickets\u{1e}\n",
    "27545321bbb5b5adf281deded8f09c0b9ba6b61d\u{1f}2754532\u{1f}Paul Adrianne Mojal\u{1f}",
    "paul.mojal@gmail.com\u{1f}1791788546\u{1f}",
    "b78cbb38cce2033117ad722698b4cb4ba732a2fc 058679cc860c63869b5785b2f38afde127704588\u{1f}\u{1f}",
    "Merge pull request #202 from concurrentilabcict/dev-paul\u{1e}\n",
    "058679cc860c63869b5785b2f38afde127704588\u{1f}058679c\u{1f}Polstuds27\u{1f}",
    "paul.mojal@gmail.com\u{1f}1791788504\u{1f}b78cbb38cce2033117ad722698b4cb4ba732a2fc\u{1f}\u{1f}",
    "update: optimized repair logs\u{1e}\n",
    "b78cbb38cce2033117ad722698b4cb4ba732a2fc\u{1f}b78cbb3\u{1f}Paul Adrianne Mojal\u{1f}",
    "paul.mojal@gmail.com\u{1f}1791773487\u{1f}",
    "757d225e9a4453ba39acbd8ac9bebd92744f1aca ccafb7cca57dfbbac745741abbf40acb82338770\u{1f}\u{1f}",
    "Merge pull request #201 from concurrentilabcict/dev-paul\u{1e}",
  );

  #[test]
  fn parses_every_record_from_real_git_output() {
    let commits = parse_log_output(REAL_LOG);
    assert_eq!(commits.len(), 4);
  }

  #[test]
  fn reads_scalar_fields_in_order() {
    let commits = parse_log_output(REAL_LOG);
    let head = &commits[0];

    assert_eq!(head.hash, "c3f8dab4109ec5a611cb5a137226c337a1f590ed");
    assert_eq!(head.short_hash, "c3f8dab");
    assert_eq!(head.subject, "update: excluded archived tickets");
    assert_eq!(head.author_name, "Polstuds27");
    assert_eq!(head.author_email, "paul.mojal@gmail.com");
    assert_eq!(head.authored_at, 1791986635);
  }

  #[test]
  fn splits_comma_separated_decorations() {
    let commits = parse_log_output(REAL_LOG);
    assert_eq!(
      commits[0].decorations,
      vec!["HEAD -> dev-paul".to_string(), "origin/dev-paul".to_string()]
    );
    // A merge with no refs yields an empty list, not a blank entry.
    assert!(commits[1].decorations.is_empty());
  }

  #[test]
  fn keeps_every_parent_hash_and_flags_merges() {
    let commits = parse_log_output(REAL_LOG);

    assert_eq!(
      commits[0].parents,
      vec!["27545321bbb5b5adf281deded8f09c0b9ba6b61d"]
    );
    assert!(!commits[0].is_merge);

    assert_eq!(
      commits[1].parents,
      vec![
        "b78cbb38cce2033117ad722698b4cb4ba732a2fc".to_string(),
        "058679cc860c63869b5785b2f38afde127704588".to_string(),
      ]
    );
    assert!(commits[1].is_merge, "two parents means a merge commit");
  }

  #[test]
  fn tolerates_empty_and_malformed_records() {
    assert!(parse_log_output("").is_empty());
    assert!(parse_log_output("\u{1e}\n\u{1e}").is_empty());
    // Too few fields to be a commit — skipped rather than panicking.
    assert!(parse_log_output("abc\u{1f}def\u{1e}").is_empty());
  }

  /// Captured from `git diff --name-status -z` on a real repository containing
  /// copies and renames.
  const NAME_STATUS: &str = concat!(
    "A\u{0}new/file.py\u{0}",
    "M\u{0}changed.py\u{0}",
    "D\u{0}gone.py\u{0}",
    "R096\u{0}old/name.py\u{0}new/name.py\u{0}",
    "C100\u{0}src/orig.py\u{0}src/copy.py\u{0}",
  );

  #[test]
  fn parses_name_status_including_renames_and_copies() {
    let parsed = parse_name_status(NAME_STATUS);

    assert_eq!(
      parsed
        .iter()
        .map(|(s, p, o)| (*s, p.as_str(), o.as_deref()))
        .collect::<Vec<_>>(),
      vec![
        (FileStatus::Added, "new/file.py", None),
        (FileStatus::Modified, "changed.py", None),
        (FileStatus::Deleted, "gone.py", None),
        (FileStatus::Renamed, "new/name.py", Some("old/name.py")),
        (FileStatus::Copied, "src/copy.py", Some("src/orig.py")),
      ]
    );
  }

  #[test]
  fn name_status_survives_a_truncated_record() {
    // A trailing status with no path must not panic or invent a path.
    let parsed = parse_name_status("M\u{0}a.py\u{0}M\u{0}");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].1, "a.py");
  }

  /// `git diff --numstat -z`; binary files report `-`, and a rename carries an
  /// empty path field followed by old and new paths.
  const NUMSTAT: &str = concat!(
    "25\t0\tclient/components.json\u{0}",
    "10\t2\tclient/src/App.tsx\u{0}",
    "-\t-\tclient/src/assets/logo.png\u{0}",
    "7\t1\t\u{0}old/name.py\u{0}new/name.py\u{0}",
  );

  #[test]
  fn parses_numstat_counts_and_binary_markers() {
    let parsed = parse_numstat(NUMSTAT);

    assert_eq!(parsed[0], (Some(25), Some(0), "client/components.json".to_string()));
    assert_eq!(parsed[1], (Some(10), Some(2), "client/src/App.tsx".to_string()));
    // Binary: counts are absent, so the UI can say "binary" rather than "0".
    assert_eq!(parsed[2].0, None);
    assert_eq!(parsed[2].1, None);
    assert_eq!(parsed[2].2, "client/src/assets/logo.png");
    // Rename: keyed by the new path.
    assert_eq!(parsed[3], (Some(7), Some(1), "new/name.py".to_string()));
  }

  #[test]
  fn numstat_tolerates_empty_and_broken_records() {
    assert!(parse_numstat("").is_empty());
    assert!(parse_numstat("\u{0}\u{0}").is_empty());
    // A token without tabs is not a numstat record and must be skipped, not
    // misread as a count.
    assert!(parse_numstat("garbage\u{0}").is_empty());
  }

  #[test]
  fn three_dot_and_two_dot_ranges_are_distinct() {
    // `mergeBase` compares merge-base to tip; `direct` compares tip to tip.
    assert_eq!(diff_args("aaa", "bbb", "mergeBase"), vec!["aaa...bbb".to_string()]);
    assert_eq!(
      diff_args("aaa", "bbb", "direct"),
      vec!["aaa".to_string(), "bbb".to_string()]
    );
    // Anything other than an explicit `direct` falls back to merge-base mode.
    assert_eq!(diff_args("aaa", "bbb", "nonsense"), vec!["aaa...bbb".to_string()]);
  }

  // ── End-to-end command tests against a real, disposable repository ─────────

  /// Builds a small repository with a modified, added, deleted, renamed, and
  /// binary file, where both branches edit the *same* line of `edit.txt` so the
  /// merge genuinely conflicts. Returns `None` if Git is unavailable.
  fn fixture_repo(name: &str) -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("branchmap-test-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;

    let ok = |args: &[&str]| {
      run_git(Some(&dir), args)
        .map(|o| o.status == 0)
        .unwrap_or(false)
    };

    if !ok(&["init", "-q", "-b", "main"]) {
      return None;
    }
    ok(&["config", "user.email", "test@example.com"]);
    ok(&["config", "user.name", "Test"]);

    std::fs::write(dir.join("keep.txt"), "unchanged\n").ok()?;
    std::fs::write(dir.join("edit.txt"), "one\ntwo\nthree\n").ok()?;
    std::fs::write(dir.join("gone.txt"), "bye\n").ok()?;
    std::fs::write(dir.join("old_name.txt"), "renamed content\n").ok()?;
    std::fs::write(dir.join("image.bin"), [0u8, 1, 2, 3, 0, 255]).ok()?;
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "base"]);

    ok(&["checkout", "-q", "-b", "feature"]);
    std::fs::write(dir.join("edit.txt"), "one\nFEATURE\nthree\n").ok()?;
    std::fs::write(dir.join("added.txt"), "brand new\n").ok()?;
    // Change the binary file so binary detection is exercised by a real diff.
    std::fs::write(dir.join("image.bin"), [9u8, 8, 7, 6, 0, 255]).ok()?;
    std::fs::remove_file(dir.join("gone.txt")).ok()?;
    ok(&["mv", "old_name.txt", "new_name.txt"]);
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "feature work"]);

    ok(&["checkout", "-q", "main"]);
    // Same line as the feature branch edits — this is what creates the conflict.
    std::fs::write(dir.join("edit.txt"), "one\nMAIN\nthree\n").ok()?;
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "main work"]);

    Some(dir)
  }

  #[test]
  fn branch_ref_lines_survive_pipes_in_the_subject() {
    // Captured from `git for-each-ref`; the subject itself contains a `|`.
    let text = concat!(
      "feature/x|8eaef2d6483fce9cbc6e870a0d721cdf2112df7a|*||subject with | pipe char\n",
      "main|093de6f2f8554009540edf497046b54ec9f8adad| ||base\n",
    );

    let parsed: Vec<BranchInfo> = text
      .lines()
      .filter(|l| !l.trim().is_empty())
      .filter_map(|line| {
        let f: Vec<&str> = line.splitn(5, '|').collect();
        (f.len() == 5).then(|| BranchInfo {
          name: f[0].to_string(),
          commit: f[1].trim().to_string(),
          is_head: f[2].trim() == "*",
          upstream: (!f[3].trim().is_empty()).then(|| f[3].to_string()),
          subject: f[4].to_string(),
        })
      })
      .collect();

    assert_eq!(parsed.len(), 2);
    assert_eq!(parsed[0].name, "feature/x");
    assert!(parsed[0].is_head);
    assert_eq!(parsed[0].upstream, None);
    // The pipe inside the subject must survive intact.
    assert_eq!(parsed[0].subject, "subject with | pipe char");
    assert_eq!(parsed[1].name, "main");
    assert!(!parsed[1].is_head);
    assert_eq!(parsed[1].subject, "base");
  }

  #[test]
  fn lists_real_branches_and_head() {
    let Some(dir) = fixture_repo("branches") else { return };
    let path = dir.to_string_lossy().to_string();

    let list = list_branches(path).expect("list_branches should succeed");

    let names: Vec<&str> = list.branches.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"main"), "expected main in {names:?}");
    assert!(names.contains(&"feature"), "expected feature in {names:?}");
    assert_eq!(list.head.as_deref(), Some("main"));
    assert!(!list.detached);
    assert!(list.has_commits);

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn compares_branches_and_reports_every_file_status() {
    let Some(dir) = fixture_repo("compare") else { return };
    let path = dir.to_string_lossy().to_string();

    let result =
      compare_branches(path.clone(), "main".into(), "feature".into(), None, None).unwrap();

    assert_eq!(result.mode, "mergeBase");
    assert_eq!(result.ahead, 1, "feature has exactly one commit base lacks");
    assert_eq!(result.behind, 1, "main has exactly one commit feature lacks");
    assert!(result.merge_base.is_some());
    assert_eq!(result.commits.len(), 1, "log base..compare is one commit");
    assert_eq!(result.commits[0].subject, "feature work");

    let by_path = |p: &str| {
      result
        .files
        .iter()
        .find(|f| f.path == p)
        .unwrap_or_else(|| panic!("missing {p} in {:?}", result.files))
        .clone()
    };

    assert_eq!(by_path("added.txt").status, FileStatus::Added);
    assert_eq!(by_path("edit.txt").status, FileStatus::Modified);
    assert_eq!(by_path("gone.txt").status, FileStatus::Deleted);

    let renamed = by_path("new_name.txt");
    assert_eq!(renamed.status, FileStatus::Renamed);
    assert_eq!(renamed.old_path.as_deref(), Some("old_name.txt"));

    let binary = by_path("image.bin");
    assert!(binary.binary);
    assert_eq!(binary.insertions, None, "binary files report no line counts");

    // Both branches edited edit.txt after the merge base.
    assert!(by_path("edit.txt").overlap, "edit.txt should be flagged as overlapping");
    assert_eq!(result.overlap_count, 1);

    assert!(result.totals.insertions > 0 && result.totals.deletions > 0);
    assert_eq!(result.totals.binary_files, 1);

    // An unrelated branch name must fail with a structured error, not a panic.
    let err = compare_branches(path.clone(), "main".into(), "nope".into(), None, None)
      .expect_err("unknown branch should be an error");
    assert_eq!(err.kind, ErrorKind::NotARepository);
    assert!(err.hint.is_some(), "errors should carry an actionable hint");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn returns_real_unified_diff_for_one_file() {
    let Some(dir) = fixture_repo("diff") else { return };
    let path = dir.to_string_lossy().to_string();

    let modified =
      get_file_diff(path.clone(), "main".into(), "feature".into(), "edit.txt".into(), None)
        .unwrap();
    assert!(!modified.binary);
    assert!(modified.diff.contains("FEATURE"), "diff should contain the feature line");
    assert!(!modified.diff.contains("MAIN"), "merge-base diff excludes main-only changes");
    assert_eq!(modified.additions, 1);
    assert_eq!(modified.deletions, 1);

    // A binary file is flagged as binary; Git still emits a "Binary files differ"
    // notice rather than hunks, and the viewer must not try to render hunks.
    let binary =
      get_file_diff(path.clone(), "main".into(), "feature".into(), "image.bin".into(), None)
        .unwrap();
    assert!(binary.binary);
    assert!(binary.diff.contains("Binary files"));
    assert_eq!(binary.additions, 0, "binary diffs contribute no line counts");
    assert_eq!(binary.deletions, 0);

    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A repository whose history contains a root commit, a rename, a binary
  /// change, an empty commit, and a genuine two-parent merge.
  fn rich_fixture_repo() -> Option<PathBuf> {
    let dir = std::env::temp_dir().join(format!("branchmap-commit-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;

    let ok = |args: &[&str]| run_git(Some(&dir), args).map(|o| o.status == 0).unwrap_or(false);

    if !ok(&["init", "-q", "-b", "main"]) {
      return None;
    }
    ok(&["config", "user.email", "test@example.com"]);
    ok(&["config", "user.name", "Test"]);

    // Root commit introduces everything, including the file later renamed.
    std::fs::write(dir.join("original.txt"), "alpha\nbeta\n").ok()?;
    std::fs::write(dir.join("pic.png"), [1u8, 2, 3, 0, 255]).ok()?;
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "root commit"]);

    // Side branch renames the file.
    ok(&["checkout", "-q", "-b", "side"]);
    ok(&["mv", "original.txt", "renamed.txt"]);
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "rename it"]);

    // Main continues independently, then merges without conflict.
    ok(&["checkout", "-q", "main"]);
    std::fs::write(dir.join("main_only.txt"), "on main\n").ok()?;
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "main work"]);
    ok(&["merge", "-q", "--no-ff", "-m", "merge side", "side"]);

    // An empty commit changes nothing at all.
    std::fs::write(dir.join("keep.txt"), "keep\n").ok()?;
    ok(&["add", "-A"]);
    ok(&["commit", "-qm", "add keep"]);
    ok(&["commit", "-q", "--allow-empty", "-m", "empty commit"]);

    Some(dir)
  }

  #[test]
  fn root_commit_changes_are_measured_against_the_empty_tree() {
    let Some(dir) = rich_fixture_repo() else { return };
    let path = dir.to_string_lossy().to_string();

    let root = run_git(Some(&dir), &["rev-list", "--max-parents=0", "HEAD"])
      .unwrap()
      .stdout
      .trim()
      .to_string();

    let changes = get_commit_changes(path.clone(), root.clone(), None).unwrap();

    assert!(changes.is_root);
    assert!(!changes.is_merge);
    assert!(changes.parents.is_empty());
    assert_eq!(changes.mode, "firstParent");
    // Every file in the root commit is reported as added.
    assert_eq!(changes.totals.files, 2);
    assert!(changes.files.iter().all(|f| f.status == FileStatus::Added));
    assert!(
      changes.comparison.contains("empty tree"),
      "comparison should explain the reference: {}",
      changes.comparison
    );

    // A per-file diff for a root commit resolves without a parent.
    let diff = get_commit_diff(path, root, "original.txt".into(), None).unwrap();
    assert!(!diff.binary);
    assert!(diff.diff.contains("alpha"));

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn merge_commit_states_its_comparison_explicitly() {
    let Some(dir) = rich_fixture_repo() else { return };
    let path = dir.to_string_lossy().to_string();

    let merge = run_git(Some(&dir), &["rev-list", "--merges", "-n", "1", "HEAD"])
      .unwrap()
      .stdout
      .trim()
      .to_string();

    let changes = get_commit_changes(path.clone(), merge.clone(), None).unwrap();
    assert!(changes.is_merge);
    assert_eq!(changes.parents.len(), 2);
    // The first-parent view must say so, rather than implying it is the merge result.
    assert!(
      changes.comparison.contains("first parent"),
      "comparison must name the semantics: {}",
      changes.comparison
    );
    assert!(changes.comparison.contains("does not describe the whole merge"));
    assert!(changes.stats_available);

    // The combined view is a different, explicitly named question.
    let combined = get_commit_changes(path.clone(), merge.clone(), Some("combined".into())).unwrap();
    assert_eq!(combined.mode, "combined");
    assert!(!combined.stats_available, "combined diffs report no line counts");
    assert!(combined.comparison.contains("every parent"));

    // Git produces no per-file unified diff for a combined merge diff.
    let err = get_commit_diff(path, merge, "main_only.txt".into(), Some("combined".into()))
      .expect_err("combined per-file diff should be refused, not faked");
    assert!(err.hint.is_some());

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn per_commit_changes_cover_renames_binary_and_empty_commits() {
    let Some(dir) = rich_fixture_repo() else { return };
    let path = dir.to_string_lossy().to_string();

    let rename_commit = run_git(
      Some(&dir),
      &["log", "--format=%H", "--diff-filter=R", "-n", "1", "HEAD"],
    )
    .unwrap()
    .stdout
    .trim()
    .to_string();

    let changes = get_commit_changes(path.clone(), rename_commit, None).unwrap();
    let renamed = changes
      .files
      .iter()
      .find(|f| f.status == FileStatus::Renamed)
      .expect("rename should be detected");
    assert_eq!(renamed.path, "renamed.txt");
    assert_eq!(renamed.old_path.as_deref(), Some("original.txt"));

    // The merge brings in a binary file from the side branch.
    let merge = run_git(Some(&dir), &["rev-list", "--merges", "-n", "1", "HEAD"])
      .unwrap()
      .stdout
      .trim()
      .to_string();
    let merge_changes = get_commit_changes(path.clone(), merge, None).unwrap();
    assert!(
      merge_changes.files.iter().any(|f| f.path == "pic.png" || f.path == "renamed.txt"),
      "merge should show changes introduced on the side branch: {:?}",
      merge_changes.files
    );

    // An empty commit legitimately changes nothing.
    let empty = run_git(Some(&dir), &["log", "--format=%H", "--grep=^empty commit$", "-n", "1", "HEAD"])
      .unwrap()
      .stdout
      .trim()
      .to_string();
    let empty_changes = get_commit_changes(path.clone(), empty.clone(), None).unwrap();
    assert!(empty_changes.files.is_empty(), "an empty commit has no file changes");
    assert_eq!(empty_changes.totals.files, 0);

    // Binary diffs are flagged rather than rendered as line changes.
    let binary = get_commit_diff(path, empty, "pic.png".into(), None);
    assert!(binary.is_ok(), "a valid path should still resolve");

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn write_text_file_writes_and_refuses_bad_destinations() {
    let Some(dir) = rich_fixture_repo() else { return };

    let target = dir.join("report.md");
    let written = write_text_file(
      target.to_string_lossy().to_string(),
      "# Report\n\nreal data\n".to_string(),
    )
    .unwrap();

    assert_eq!(written.bytes, "# Report\n\nreal data\n".len());
    assert_eq!(
      std::fs::read_to_string(&target).unwrap(),
      "# Report\n\nreal data\n",
      "the file must contain exactly what was written"
    );

    assert!(write_text_file(String::new(), "x".into()).is_err(), "empty path must fail");

    let missing = dir.join("no-such-dir").join("report.md");
    assert!(
      write_text_file(missing.to_string_lossy().to_string(), "x".into()).is_err(),
      "a missing parent directory must fail with a structured error"
    );

    let huge = "a".repeat(MAX_REPORT_BYTES + 1);
    assert!(
      write_text_file(target.to_string_lossy().to_string(), huge).is_err(),
      "oversized reports must be refused"
    );

    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn merge_preview_reports_the_real_conflict() {
    let Some(dir) = fixture_repo("merge") else { return };
    let path = dir.to_string_lossy().to_string();

    let preview = preview_merge(path, "main".into(), "feature".into()).unwrap();

    assert!(preview.supported);
    assert!(!preview.clean, "the fixture edits the same line on both branches");
    assert!(
      preview.conflicts.iter().any(|c| c == "edit.txt"),
      "expected edit.txt conflict, got {:?}",
      preview.conflicts
    );
    assert!(preview.message.contains("estimate"), "must not overstate certainty");

    let _ = std::fs::remove_dir_all(&dir);
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      check_git_installation,
      validate_repository,
      list_commits,
      list_branches,
      compare_branches,
      get_file_diff,
      preview_merge,
      get_commit_changes,
      get_commit_diff,
      write_text_file,
      ollama::ollama_status,
      ollama::ollama_start,
      ollama::ollama_warmup,
      ollama::ai_explain,
      ollama::ai_default_model,
      diag::ai_diagnostics
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
