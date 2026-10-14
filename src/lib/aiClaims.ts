import type { Commit, CommitChanges, Comparison } from '../types'

/**
 * Code-level guardrails for model output.
 *
 * Prompt wording alone is not enough: a small local model can misstate the
 * comparison direction, omit the fact/inference split, or claim a merge is safe.
 * These helpers make the verified facts deterministic (computed by BranchMap from
 * real Git results, never by the model) and flag unsupported claims so the UI
 * can qualify them.
 */

export interface VerifiedFacts {
  /** Short heading, e.g. "main → feature/laboratory". */
  title: string
  /** Deterministic facts, each true regardless of what the model said. */
  lines: string[]
  /** True when a diff excerpt was clipped, so evidence is incomplete. */
  evidenceTruncated: boolean
}

/** Builds the verified block for a branch comparison. */
export function verifiedForComparison(
  comparison: Comparison | null,
  excerptTruncated: boolean,
): VerifiedFacts | null {
  if (!comparison) return null

  const lines = [
    `Comparison direction: ${comparison.base} → ${comparison.compare}`,
    comparison.mode === 'direct'
      ? 'Diff basis: the two branch tips, compared directly'
      : 'Diff basis: from the merge base to the comparison branch tip',
    comparison.mergeBase
      ? `Merge base: ${comparison.mergeBase}`
      : 'Merge base: none — the branches share no common ancestor',
    `Commits only on ${comparison.compare}: ${comparison.ahead}`,
    `Commits only on ${comparison.base}: ${comparison.behind}`,
    `Files changed: ${comparison.totals.files}`,
    `Line totals: +${comparison.totals.insertions} insertions, -${comparison.totals.deletions} deletions`,
  ]

  const overlap = comparison.files.filter((f) => f.overlap)
  lines.push(
    overlap.length > 0
      ? `Paths changed on both sides since the merge base: ${overlap.length} (overlap only — not a confirmed conflict)`
      : 'No paths were changed on both sides since the merge base',
  )

  return {
    title: `${comparison.base} → ${comparison.compare}`,
    lines,
    evidenceTruncated: excerptTruncated,
  }
}

/** Builds the verified block for a single commit. */
export function verifiedForCommit(
  commit: Commit | null,
  changes: CommitChanges | null,
  excerptTruncated: boolean,
): VerifiedFacts | null {
  if (!commit) return null

  const lines = [
    `Commit: ${commit.hash}`,
    `Subject: ${commit.subject}`,
    `Author: ${commit.authorName}`,
    `Parent count: ${commit.parents.length}`,
    commit.isMerge ? 'This is a merge commit' : 'This is not a merge commit',
  ]

  if (changes) {
    lines.push(`Files changed: ${changes.files.length}`)
    lines.push(`Comparison basis: ${changes.comparison}`)
    if (changes.statsAvailable) {
      lines.push(`Line totals: +${changes.totals.insertions} / -${changes.totals.deletions}`)
    }
  }

  return {
    title: commit.subject || commit.shortHash,
    lines,
    evidenceTruncated: excerptTruncated,
  }
}

export interface ClaimFinding {
  /** Short label shown to the user. */
  kind: string
  /** The offending snippet, clipped. */
  excerpt: string
}

/**
 * Phrases BranchMap cannot substantiate from Git data alone.
 *
 * These are *observations about the text*, not proof the model was wrong — the
 * UI presents them as "verify this yourself", never as an automatic correction.
 */
const RISKY: { kind: string; pattern: RegExp }[] = [
  { kind: 'causal claim', pattern: /\b(caused|causes|causing|fixed|breaks|broke)\b[^.\n]{0,60}\b(bug|issue|crash|error|regression)\b/i },
  { kind: 'merge-safety claim', pattern: /\b(merge is safe|safe to merge|will not conflict|no conflicts will|guaranteed? (to )?(merge|succeed)|cannot fail)\b/i },
  { kind: 'test-result claim', pattern: /\b(all tests pass|tests pass|test suite passes|verified by tests)\b/i },
  { kind: 'certainty claim', pattern: /\b(definitely|certainly|guarantees?|always will)\b/i },
]

/** Scans model output for claims BranchMap cannot verify. */
export function verifyAiClaims(text: string): ClaimFinding[] {
  const findings: ClaimFinding[] = []
  for (const { kind, pattern } of RISKY) {
    const match = pattern.exec(text)
    if (match) {
      findings.push({
        kind,
        excerpt: match[0].trim().slice(0, 90),
      })
    }
  }
  return findings
}

/** True when the model used the fact/inference labels we asked for. */
export function hasFactLabels(text: string): boolean {
  return /\b(verified fact|inference|interpretation)\b/i.test(text)
}