import type { GitInstallation, RepositoryInfo } from '../types'
import { CircleCheck, Terminal, TriangleAlert, X } from 'lucide-react'

interface StatusBarProps {
  git: GitInstallation | null
  repo: RepositoryInfo | null
  error: string | null
  onDismissError: () => void
}

export function StatusBar({ git, repo, error, onDismissError }: StatusBarProps) {
  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-surface px-3 text-[11px] text-ink-muted">
      {git?.available ? (
        <span className="flex items-center gap-1.5">
          <CircleCheck className="size-3 text-success" aria-hidden />
          <span className="selectable">Git {git.version}</span>
        </span>
      ) : (
        <span className="flex items-center gap-1.5 text-danger">
          <TriangleAlert className="size-3" aria-hidden />
          Git not found
        </span>
      )}

      {repo && (
        <>
          <span className="h-3 w-px bg-line" aria-hidden />
          <span className="selectable truncate">{repo.root}</span>
        </>
      )}

      <span className="ml-auto flex items-center gap-3">
        <span className="flex items-center gap-1.5">
          <Terminal className="size-3" aria-hidden />
          Local only — no data leaves this machine
        </span>
      </span>

      {error && (
        <span role="alert" className="flex items-center gap-1.5 text-danger">
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          <span className="max-w-[420px] truncate">{error}</span>
          <button
            type="button"
            onClick={onDismissError}
            aria-label="Dismiss error"
            className="rounded p-0.5 text-ink-faint transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="size-3" aria-hidden />
          </button>
        </span>
      )}
    </footer>
  )
}