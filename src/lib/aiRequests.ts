import type {
  AiRequest,
  AiRequestKind,
  Commit,
  CommitChanges,
  Comparison,
  FileDiff,
  MergePreview,
  RepositoryInfo,
} from '../types'

/** Diff excerpt is bounded twice: here, and again in the Rust prompt builder. */
const MAX_EXCERPT_CHARS = 4000

interface FileLike {
  path: string
  insertions?: number | null
  deletions?: number | null
  binary: boolean
}

function fileLines(files: FileLike[]): string[] {
  return files.map((f) =>
    f.binary
      ? `${f.path} (binary - no line counts)`
      : `${f.path} (+${f.insertions ?? 0}/-${f.deletions ?? 0})`,
  )
}

function excerpt(diff: FileDiff | null): string | null {
  if (!diff || diff.binary || !diff.diff.trim()) return null
  return diff.diff.slice(0, MAX_EXCERPT_CHARS)
}

/** Facts for the selected commit, taken from the real commit objects. */
export function buildCommitRequest(
  repo: RepositoryInfo,
  commit: Commit | null,
  changes: CommitChanges | null,
  diff: FileDiff | null,
  model: string,
): AiRequest | null {
  if (!commit) return null

  const facts = [
    `Repository: ${repo.name}`,
    `Commit: ${commit.hash}`,
    `Subject: ${commit.subject}`,
    `Author: ${commit.authorName} <${commit.authorEmail}>`,
    `Parent count: ${commit.parents.length}`,
    commit.isMerge ? 'This is a merge commit.' : 'This is not a merge commit.',
  ]

  if (changes) {
    facts.push(`Files changed in this commit: ${changes.files.length}`)
    facts.push(`Comparison basis: ${changes.comparison}`)
    if (changes.statsAvailable) {
      facts.push(
        `Line totals: +${changes.totals.insertions} insertions, -${changes.totals.deletions} deletions`,
      )
    }
  }

  return {
    kind: 'commit',
    model,
    title: commit.subject || commit.shortHash,
    facts,
    files: changes ? fileLines(changes.files) : [],
    diffExcerpt: excerpt(diff),
    overlap: [],
    preview: null,
  }
}

/** Facts for the current branch comparison, taken from the real comparison. */
export function buildComparisonRequest(
  repo: RepositoryInfo,
  comparison: Comparison | null,
  preview: MergePreview | null,
  kind: Exclude<AiRequestKind, 'commit'>,
  diff: FileDiff | null,
  model: string,
): AiRequest | null {
  if (!comparison) return null

  const facts = [
    `Repository: ${repo.name}`,
    `Base branch: ${comparison.base}`,
    `Comparison branch: ${comparison.compare}`,
    `Comparison mode: ${
      comparison.mode === 'direct'
        ? 'tip to tip (git diff base compare)'
        : 'from merge base (git diff base...compare)'
    }`,
    comparison.mergeBase
      ? `Merge base: ${comparison.mergeBase}`
      : 'Merge base: none, the branches have no common ancestor',
    `Commits only on ${comparison.compare}: ${comparison.ahead}`,
    `Commits only on ${comparison.base}: ${comparison.behind}`,
    `Files changed: ${comparison.totals.files}`,
    `Line totals: +${comparison.totals.insertions} insertions, -${comparison.totals.deletions} deletions`,
  ]

  if (comparison.totals.binaryFiles > 0) {
    facts.push(`Binary files changed: ${comparison.totals.binaryFiles}`)
  }

  const overlapping = comparison.files.filter((f) => f.overlap)
  if (overlapping.length > 0) {
    facts.push(
      `Paths changed on both sides since the merge base: ${overlapping.length} (overlap only, not a confirmed conflict)`,
    )
  }

  if (kind === 'risk' && overlapping.length === 0 && !preview) {
    facts.push('No overlapping paths were detected and no merge preview was run.')
  }

  return {
    kind,
    model,
    title: `${comparison.base} → ${comparison.compare}`,
    facts,
    files: fileLines(comparison.files),
    diffExcerpt: excerpt(diff),
    overlap: overlapping.map((f) => f.path),
    preview: preview ? preview.message : null,
  }
}