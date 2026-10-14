import { FolderGit2, FolderOpen, GitBranch, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { GitInstallation, RepositoryInfo } from '../types'

interface SidebarProps {
  git: GitInstallation | null
  repo: RepositoryInfo | null
  recentPaths: string[]
  busy: boolean
  onOpenRepository: () => void
  onSelectRecent: (path: string) => void
  onRemoveRecent: (path: string) => void
}

function basename(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] || cleaned
}

export function Sidebar({
  git,
  repo,
  recentPaths,
  busy,
  onOpenRepository,
  onSelectRecent,
  onRemoveRecent,
}: SidebarProps) {
  const gitMissing = git !== null && !git.available

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface">
      <div className="p-3">
        <button
          type="button"
          onClick={onOpenRepository}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-[13px] font-medium text-canvas transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <FolderOpen className="size-4" aria-hidden />
          )}
          Open repository
        </button>

        {gitMissing && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-warning">
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
            <span>Git CLI not detected. Install it from git-scm.com, then restart BranchMap.</span>
          </p>
        )}
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <section className="min-h-0 flex-1 overflow-y-auto scrollbar-slim px-3 pb-3">
          <h2 className="px-1 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
            Current
          </h2>

          {repo ? (
            <div className="rounded-md border border-line bg-raised px-3 py-2.5">
              <div className="flex items-center gap-2">
                <FolderGit2 className="size-4 shrink-0 text-accent" aria-hidden />
                <span className="truncate text-[13px] font-medium">{repo.name}</span>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-ink-muted">
                <GitBranch className="size-3 shrink-0" aria-hidden />
                {repo.detached
                  ? 'Detached HEAD'
                  : repo.currentBranch ?? (repo.hasCommits ? 'Unknown' : 'No commits yet')}
              </div>
              <p
                className="selectable mt-1 truncate text-[10px] text-ink-faint"
                title={repo.root}
              >
                {repo.root}
              </p>

              {repo.resolvedFromSubdirectory && (
                <p className="mt-1.5 rounded border border-line-soft bg-canvas px-2 py-1.5 text-[10px] leading-relaxed text-ink-faint">
                  You picked a subfolder, so Git resolved the repository above it. Showing{' '}
                  <span className="text-ink-muted">{repo.name}</span>.
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[11px] leading-relaxed text-ink-faint">
              No repository open.
              <br />
              Choose a local folder to begin.
            </p>
          )}

          {recentPaths.length > 0 && (
            <>
              <h2 className="px-1 pb-2 pt-4 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
                Recent
              </h2>
              <ul className="space-y-0.5">
                {recentPaths.map((path) => (
                  <li key={path} className="group flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => onSelectRecent(path)}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-ink-muted transition-colors hover:bg-raised hover:text-ink"
                    >
                      <FolderGit2 className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
                      <span className="truncate">{basename(path)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveRecent(path)}
                      aria-label={`Remove ${basename(path)} from recent`}
                      className="shrink-0 rounded p-1 text-[11px] text-ink-faint opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </aside>
  )
}