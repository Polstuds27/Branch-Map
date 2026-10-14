import { FolderGit2, GitBranch, RefreshCw } from 'lucide-react'
import type { RepositoryInfo } from '../types'

interface WelcomeViewProps {
  onOpenRepository: () => void
  busy: boolean
}

/** Hero shown until a repository is opened. Honest copy only — no sample history. */
export function WelcomeView({ onOpenRepository, busy }: WelcomeViewProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 px-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-xl border border-line bg-surface">
        <FolderGit2 className="size-6 text-accent" aria-hidden />
      </div>

      <div className="max-w-md space-y-2">
        <h1 className="text-lg font-semibold tracking-tight">BranchMap</h1>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Open a local Git repository to explore its history, branches, and changes. Everything is
          read directly from disk and stays on this machine.
        </p>
      </div>

      <button
        type="button"
        onClick={onOpenRepository}
        disabled={busy}
        className="flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-canvas transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <FolderGit2 className="size-4" aria-hidden />
        Open a repository
      </button>

      <p className="max-w-sm text-[11px] leading-relaxed text-ink-faint">
        No account, no cloud sync, no telemetry. BranchMap only reads what is already on your disk.
      </p>
    </div>
  )
}

/** Compact repository facts shown above the workspace. */
export function RepoSummaryStrip({ repo, busy, onRefresh }: { repo: RepositoryInfo; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-4 border-b border-line bg-surface/40 px-4 py-1.5 text-[11px] text-ink-muted">
      <span className="flex items-center gap-1.5">
        <GitBranch className="size-3" aria-hidden />
        {repo.currentBranch ?? (repo.detached ? 'detached' : 'unborn')}
      </span>
      <span className="selectable">{repo.headSha ? repo.headSha.slice(0, 7) : 'no commits'}</span>
      <span>{repo.clean ? 'clean' : `${repo.changedFiles} changed`}</span>
      {repo.untrackedFiles > 0 && <span>{repo.untrackedFiles} untracked</span>}

      <button
        type="button"
        onClick={onRefresh}
        disabled={busy}
        aria-label="Refresh repository"
        className="ml-auto rounded p-1 text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
      >
        <RefreshCw className="size-3" aria-hidden />
      </button>
    </div>
  )
}