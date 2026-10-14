import { LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { CommitGraph, CommitHistoryStates } from './CommitGraph'
import type { Commit, CommitPage, GitError, RepositoryInfo } from '../types'

interface CommitHistoryProps {
  repo: RepositoryInfo
  commits: Commit[]
  page: CommitPage | null
  loading: boolean
  loadingMore: boolean
  error: GitError | null
  selectedHash: string | null
  busy: boolean
  onSelect: (hash: string) => void
  onRefresh: () => void
  onRetry: () => void
  onLoadMore: () => void
}

export function CommitHistory({
  repo,
  commits,
  page,
  loading,
  loadingMore,
  error,
  selectedHash,
  busy,
  onSelect,
  onRefresh,
  onRetry,
  onLoadMore,
}: CommitHistoryProps) {
  const showGraph = !loading && !error && commits.length > 0

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-3">
        <span className="text-[12px] text-ink-muted">
          {loading ? 'Loading…' : `${commits.length} of ${page?.total ?? 0} commits`}
        </span>

        {page?.shallow && (
          <span className="flex items-center gap-1.5 text-[11px] text-warning">
            <TriangleAlert className="size-3" aria-hidden />
            Shallow clone — history is incomplete
          </span>
        )}

        {page?.truncated && (
          <span className="flex items-center gap-1.5 text-[11px] text-warning">
            <TriangleAlert className="size-3" aria-hidden />
            Output limit reached — older commits are not shown
          </span>
        )}

        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          aria-label="Refresh commit history"
          className="ml-auto rounded-md border border-line bg-surface p-1.5 text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
        >
          <RefreshCw className="size-3.5" aria-hidden />
        </button>
      </div>

      {showGraph ? (
        <>
          <CommitGraph commits={commits} selectedHash={selectedHash} onSelect={onSelect} />

          <div className="shrink-0 border-t border-line px-3 py-2">
            {page?.hasMore ? (
              <button
                type="button"
                onClick={onLoadMore}
                disabled={loadingMore}
                className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-surface px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
              >
                {loadingMore && <LoaderCircle className="size-3.5 animate-spin" aria-hidden />}
                Load older commits
              </button>
            ) : (
              <p className="text-center text-[11px] text-ink-faint">
                End of history for {repo.name}
              </p>
            )}
          </div>
        </>
      ) : (
        <CommitHistoryStates page={page} loading={loading} error={error} onRetry={onRetry} />
      )}
    </div>
  )
}