import { GitBranch, Network } from 'lucide-react'
import type { RepositoryInfo } from '../types'

interface TitleBarProps {
  repo: RepositoryInfo | null
}

export function TitleBar({ repo }: TitleBarProps) {
  return (
    <header
      data-tauri-drag-region
      className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface px-4"
    >
      <div className="flex items-center gap-2">
        <Network className="size-4 text-accent" aria-hidden />
        <span className="text-[13px] font-semibold tracking-tight">BranchMap</span>
      </div>

      <span className="h-4 w-px bg-line" aria-hidden />

      <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-ink-muted">
        <GitBranch className="size-3.5 shrink-0 text-ink-faint" aria-hidden />
        <span className="truncate">
          {repo
            ? repo.detached
              ? `detached @ ${repo.headSha?.slice(0, 7) ?? 'HEAD'}`
              : (repo.currentBranch ?? 'no branch')
            : 'No repository'}
        </span>
      </span>
    </header>
  )
}