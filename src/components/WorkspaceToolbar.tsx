import { GitCompareArrows, Info, Sparkles } from 'lucide-react'

export type PanelKey = 'details' | 'compare' | 'ai'

interface WorkspaceToolbarProps {
  activePanel: PanelKey
  hasRepo: boolean
  onSelectPanel: (panel: PanelKey) => void
}

const TABS: { key: PanelKey; label: string; icon: typeof Info; needsRepo: boolean }[] = [
  { key: 'details', label: 'Commit details', icon: Info, needsRepo: false },
  { key: 'compare', label: 'Compare branches', icon: GitCompareArrows, needsRepo: true },
  { key: 'ai', label: 'AI explanation', icon: Sparkles, needsRepo: true },
]

export function WorkspaceToolbar({ activePanel, hasRepo, onSelectPanel }: WorkspaceToolbarProps) {
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-canvas px-3">
      {TABS.map(({ key, label, icon: Icon, needsRepo }) => {
        const disabled = needsRepo && !hasRepo
        const active = activePanel === key

        return (
          <button
            key={key}
            type="button"
            onClick={() => onSelectPanel(key)}
            disabled={disabled}
            title={disabled ? 'Open a repository first' : undefined}
            className={[
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors',
              active
                ? 'bg-raised text-ink'
                : 'text-ink-muted hover:bg-raised/60 hover:text-ink',
              disabled ? 'cursor-not-allowed opacity-40 hover:bg-transparent' : '',
            ].join(' ')}
          >
            <Icon className="size-3.5" aria-hidden />
            {label}
          </button>
        )
      })}
    </div>
  )
}