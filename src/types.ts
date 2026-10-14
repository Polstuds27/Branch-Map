/** Shapes exchanged with the Rust backend. Keep in sync with `src-tauri/src/lib.rs`. */

export type ErrorKind = 'gitNotFound' | 'invalidPath' | 'notARepository' | 'timeout' | 'gitFailed'

export interface GitError {
  kind: ErrorKind
  message: string
  hint?: string | null
}

export interface GitInstallation {
  available: boolean
  version?: string | null
  path?: string | null
  message?: string | null
}

export interface Commit {
  hash: string
  shortHash: string
  subject: string
  authorName: string
  authorEmail: string
  /** Author date as Unix seconds. */
  authoredAt: number
  /** Parent hashes in Git order; the first is the mainline parent. */
  parents: string[]
  /** Refs pointing at this commit, e.g. "HEAD -> main", "tag: v1.0". */
  decorations: string[]
  isMerge: boolean
}

export interface CommitPage {
  commits: Commit[]
  total: number
  hasMore: boolean
  shallow: boolean
  truncated: boolean
}

export interface BranchInfo {
  name: string
  commit: string
  isHead: boolean
  upstream?: string | null
  subject: string
}

export interface BranchList {
  branches: BranchInfo[]
  /** Absent when HEAD is detached. */
  head?: string | null
  detached: boolean
  hasCommits: boolean
}

export type FileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'typeChanged'
  | 'unmerged'
  | 'unknown'

export interface FileChange {
  /** Path after the change (the new path for renames and copies). */
  path: string
  oldPath?: string | null
  status: FileStatus
  /** Absent for binary files, where Git reports no line counts. */
  insertions?: number | null
  deletions?: number | null
  binary: boolean
  /** Changed on both sides since the merge base. An overlap indicator, not a
   *  confirmed conflict. */
  overlap: boolean
}

export interface DiffTotals {
  files: number
  insertions: number
  deletions: number
  binaryFiles: number
}

/** `mergeBase` compares from the merge base (`base...compare`);
 *  `direct` compares the two tips (`base compare`). */
export type DiffMode = 'mergeBase' | 'direct'

export interface Comparison {
  base: string
  compare: string
  mode: DiffMode
  baseSha: string
  compareSha: string
  mergeBase?: string | null
  mergeBaseSubject?: string | null
  /** Commits reachable from `compare` but not `base` (`git log base..compare`). */
  ahead: number
  behind: number
  commits: Commit[]
  commitsTruncated: boolean
  files: FileChange[]
  filesTruncated: boolean
  totals: DiffTotals
  overlapCount: number
}

export interface FileDiff {
  path: string
  binary: boolean
  truncated: boolean
  /** Raw unified diff text. Render as text only — never as HTML. */
  diff: string
  additions: number
  deletions: number
}

export interface MergePreview {
  supported: boolean
  clean: boolean
  conflicts: string[]
  tree?: string | null
  message: string
}

/** `firstParent` compares against the first parent; `combined` lists only files
 *  that differ from every parent (merge resolutions). */
export type CommitParentMode = 'firstParent' | 'combined'

export interface CommitChanges {
  commit: string
  shortHash: string
  subject: string
  parents: string[]
  isMerge: boolean
  isRoot: boolean
  mode: CommitParentMode
  /** Plain-language description of what the file list represents. */
  comparison: string
  files: FileChange[]
  totals: DiffTotals
  truncated: boolean
  /** False in combined mode, where Git reports no line counts. */
  statsAvailable: boolean
}

// ── Local AI (Ollama) ───────────────────────────────────────────────────────

/** Lifecycle of the local AI feature. */
export type AiState =
  | 'idle'
  | 'checking'
  | 'starting'
  | 'loading'
  | 'ready'
  | 'unavailable'
  | 'error'

export interface OllamaModel {
  name: string
  size: number
}

export interface OllamaStatus {
  installed: boolean
  running: boolean
  version?: string | null
  /** Always a loopback address; BranchMap never contacts a remote model host. */
  endpoint: string
  models: OllamaModel[]
  selectedModel: string
  selectedModelAvailable: boolean
  /** Command the user can run to install the model. Never run automatically. */
  installHint?: string | null
  message?: string | null
}

/** What the user asked to explain. `facts` must come from real Git commands. */
export type AiRequestKind = 'branch' | 'commit' | 'risk' | 'tests'

export interface AiRequest {
  kind: AiRequestKind
  model: string
  title: string
  facts: string[]
  files: string[]
  diffExcerpt?: string | null
  overlap: string[]
  preview?: string | null
}

export interface AiExplanation {
  text: string
  model: string
  truncated: boolean
  elapsedMs: number
}

export interface WrittenFile {
  path: string
  bytes: number
}

export interface RepositoryInfo {
  path: string
  name: string
  root: string
  gitDir: string
  hasCommits: boolean
  currentBranch?: string | null
  detached: boolean
  headSha?: string | null
  /** The picked folder was a subdirectory; Git resolved an ancestor repo instead. */
  resolvedFromSubdirectory: boolean
  clean: boolean
  changedFiles: number
  untrackedFiles: number
}

/** Normalises a thrown Tauri/Rust error into the structured shape the UI expects. */
export function toGitError(error: unknown): GitError {
  if (typeof error === 'object' && error !== null && 'kind' in error && 'message' in error) {
    const candidate = error as { kind?: string; message?: string; hint?: string | null }
    return {
      kind: (candidate.kind as ErrorKind) ?? 'gitFailed',
      message: candidate.message ?? 'Unknown error',
      hint: candidate.hint ?? null,
    }
  }

  if (error instanceof Error) {
    return { kind: 'gitFailed', message: error.message, hint: null }
  }

  return { kind: 'gitFailed', message: String(error), hint: null }
}