import { invoke } from '@tauri-apps/api/core'
import type {
  BranchList,
  CommitChanges,
  CommitPage,
  CommitParentMode,
  Comparison,
  DiffMode,
  FileDiff,
  GitInstallation,
  MergePreview,
  RepositoryInfo,
  WrittenFile,
} from '../types'

/**
 * Typed wrappers around the Rust commands. Components must not call `invoke`
 * directly, so every Git subprocess stays on the Rust side.
 */

export async function getGitInstallation(): Promise<GitInstallation> {
  return invoke<GitInstallation>('check_git_installation')
}

/** Read-only: validates a local folder is a Git working tree and returns its metadata. */
export async function validateRepository(path: string): Promise<RepositoryInfo> {
  return invoke<RepositoryInfo>('validate_repository', { path })
}

/**
 * Read-only page of real commit history, newest first.
 * `skip` is the number of commits already loaded, so pages can be appended.
 */
export async function listCommits(
  path: string,
  limit: number,
  skip: number,
): Promise<CommitPage> {
  return invoke<CommitPage>('list_commits', { path, limit, skip })
}

/** Real local branches, newest commit first. */
export async function listBranches(path: string): Promise<BranchList> {
  return invoke<BranchList>('list_branches', { path })
}

/**
 * Merge-base-aware comparison of two branches.
 * `mode` selects `base...compare` (mergeBase) or `base compare` (direct).
 * The commit list is always `base..compare` regardless of mode.
 */
export async function compareBranches(
  path: string,
  base: string,
  compare: string,
  mode: DiffMode,
): Promise<Comparison> {
  return invoke<Comparison>('compare_branches', { path, base, compare, mode })
}

/** Unified diff for one path, returned as plain text. */
export async function getFileDiff(
  path: string,
  base: string,
  compare: string,
  file: string,
  mode: DiffMode,
): Promise<FileDiff> {
  return invoke<FileDiff>('get_file_diff', { path, base, compare, file, mode })
}

/**
 * Read-only merge preview. Git's modern `merge-tree --write-tree` reports
 * conflicts without touching refs, the index, or the working tree, though it
 * does write temporary tree objects to the object database.
 */
export async function previewMerge(
  path: string,
  base: string,
  compare: string,
): Promise<MergePreview> {
  return invoke<MergePreview>('preview_merge', { path, base, compare })
}

/**
 * Files changed by a single commit. For merges, `mode` selects the first-parent
 * view or the combined view — the response states which one it used.
 */
export async function getCommitChanges(
  path: string,
  commit: string,
  mode: CommitParentMode,
): Promise<CommitChanges> {
  return invoke<CommitChanges>('get_commit_changes', { path, commit, mode })
}

/** Unified diff for one path inside a single commit. */
export async function getCommitDiff(
  path: string,
  commit: string,
  file: string,
  mode: CommitParentMode,
): Promise<FileDiff> {
  return invoke<FileDiff>('get_commit_diff', { path, commit, file, mode })
}

/**
 * Writes a generated report to a path the user chose in the native save
 * dialog. This is the only command in the app that writes to disk.
 */
export async function writeTextFile(path: string, contents: string): Promise<WrittenFile> {
  return invoke<WrittenFile>('write_text_file', { path, contents })
}