import { CircleDot, FileDiff, GitCommitVertical, GitMerge, User } from 'lucide-react'
import { formatAbsolute, formatRelative } from '../lib/time'
import type { Commit, CommitChanges, CommitParentMode, RepositoryInfo } from '../types'

interface CommitDetailsProps {
  repo: RepositoryInfo | null
  commit: Commit | null
  changes: CommitChanges | null
  changesLoading: boolean
  onParentModeChange: (mode: CommitParentMode) => void
}

/** Inspector for the selected commit. Every value is read from Git. */
export function CommitDetails({
  repo,
  commit,
  changes,
  changesLoading,
  onParentModeChange,
}: CommitDetailsProps) {
  if (!repo) {
    return (
      <EmptyPanel
        title="No repository open"
        body="Open a local repository to inspect its commits, authors, and file changes."
      />
    )
  }

  if (!commit) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center">
          <GitCommitVertical className="size-6 text-ink-faint" aria-hidden />
          <div className="space-y-1.5">
            <p className="text-[13px] font-medium text-ink-muted">No commit selected</p>
            <p className="text-[11px] leading-relaxed text-ink-faint">
              Select a row in the commit graph to see its author, date, refs, and parents.
            </p>
          </div>
        </div>

        <RepoFooter repo={repo} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim px-4 py-4">
        <p className="text-[13px] font-medium leading-snug text-ink">{commit.subject}</p>

        {commit.decorations.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {commit.decorations.map((decoration) => (
              <span
                key={decoration}
                className="rounded border border-accent-soft bg-accent-soft/40 px-1.5 py-px font-mono text-[10px] text-accent"
              >
                {decoration}
              </span>
            ))}
          </div>
        )}

        <dl className="mt-4 space-y-2.5 text-[11px]">
          <Row label="Commit">
            <span className="selectable break-all font-mono text-ink-muted">{commit.hash}</span>
          </Row>

          <Row label="Author">
            <span className="inline-flex items-center gap-1.5">
              <User className="size-3 shrink-0 text-ink-faint" aria-hidden />
              <span className="truncate">{commit.authorName}</span>
            </span>
          </Row>

          <Row label="Email">
            <span className="selectable truncate text-ink-muted">{commit.authorEmail}</span>
          </Row>

          <Row label="Date">
            <span title={formatAbsolute(commit.authoredAt)}>
              {formatAbsolute(commit.authoredAt)}
              <span className="ml-1.5 text-ink-faint">({formatRelative(commit.authoredAt)})</span>
            </span>
          </Row>

          <Row label="Parents">
            {commit.parents.length === 0 ? (
              <span className="text-ink-faint">none — root commit</span>
            ) : (
              <ul className="space-y-1">
                {commit.parents.map((parent, index) => (
                  <li key={parent} className="flex items-center gap-1.5">
                    <GitMerge
                      className={`size-3 shrink-0 ${index === 0 ? 'text-accent' : 'text-ink-faint'}`}
                      aria-hidden
                    />
                    <span className="selectable font-mono text-ink-muted">
                      {parent.slice(0, 10)}
                    </span>
                    {index === 0 && <span className="text-ink-faint">mainline</span>}
                  </li>
                ))}
              </ul>
            )}
          </Row>
        </dl>

        <CommitChangeSummary
          changes={changes}
          loading={changesLoading}
          commit={commit}
          onParentModeChange={onParentModeChange}
        />
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3">
        <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-ink-faint">
          <FileDiff className="mt-px size-3 shrink-0" aria-hidden />
          Select a file below the graph to inspect its unified diff.
        </p>
      </div>
    </div>
  )
}

/** Changed-file summary with explicit merge-comparison semantics. */
function CommitChangeSummary({
  changes,
  loading,
  commit,
  onParentModeChange,
}: {
  changes: CommitChanges | null
  loading: boolean
  commit: Commit
  onParentModeChange: (mode: CommitParentMode) => void
}) {
  if (loading) {
    return (
      <p className="mt-4 text-[11px] text-ink-faint">Reading commit changes…</p>
    )
  }

  if (!changes) return null

  return (
    <div className="mt-4 border-t border-line pt-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-medium text-ink-muted">
          {changes.files.length} file{changes.files.length === 1 ? '' : 's'} changed
        </span>
        {changes.statsAvailable && (
          <span className="text-[11px] text-success">+{changes.totals.insertions}</span>
        )}
        {changes.statsAvailable && (
          <span className="text-[11px] text-danger">-{changes.totals.deletions}</span>
        )}
      </div>

      {commit.isMerge && (
        <div className="mt-2 flex gap-1.5" role="group" aria-label="Merge comparison mode">
          <button
            type="button"
            onClick={() => onParentModeChange('firstParent')}
            aria-pressed={changes.mode === 'firstParent'}
            className={[
              'flex-1 rounded-md px-2 py-1 text-[10px] transition-colors',
              changes.mode === 'firstParent'
                ? 'bg-raised text-ink'
                : 'border border-line text-ink-faint hover:text-ink-muted',
            ].join(' ')}
          >
            vs first parent
          </button>
          <button
            type="button"
            onClick={() => onParentModeChange('combined')}
            aria-pressed={changes.mode === 'combined'}
            className={[
              'flex-1 rounded-md px-2 py-1 text-[10px] transition-colors',
              changes.mode === 'combined'
                ? 'bg-raised text-ink'
                : 'border border-line text-ink-faint hover:text-ink-muted',
            ].join(' ')}
          >
            combined
          </button>
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">{changes.comparison}</p>

      {changes.truncated && (
        <p className="mt-1 text-[10px] text-warning">
          Output limit reached — this list may be incomplete.
        </p>
      )}
    </div>
  )
}

function RepoFooter({ repo }: { repo: RepositoryInfo }) {
  return (
    <dl className="shrink-0 space-y-1.5 border-t border-line px-4 py-3 text-[11px]">
      <Row label="HEAD">
        <span className="selectable font-mono text-ink-muted">
          {repo.headSha ?? 'unborn — no commits'}
        </span>
      </Row>
      <Row label="Branch">
        <span className="inline-flex items-center gap-1.5">
          <CircleDot className="size-3 text-ink-faint" aria-hidden />
          {repo.detached ? 'detached' : (repo.currentBranch ?? 'none')}
        </span>
      </Row>
    </dl>
  )
}

export function EmptyPanel({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <p className="text-[13px] font-medium text-ink-muted">{title}</p>
      <p className="text-[11px] leading-relaxed text-ink-faint">{body}</p>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  )
}