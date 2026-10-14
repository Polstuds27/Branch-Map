import { useState } from 'react'
import {
  ArrowLeftRight,
  Download,
  FileText,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  LoaderCircle,
  TriangleAlert,
} from 'lucide-react'
import { EmptyPanel } from './CommitDetails'
import type { Comparison, DiffMode, MergePreview, RepositoryInfo } from '../types'

interface BranchCompareProps {
  repo: RepositoryInfo | null
  branches: { name: string; isHead: boolean }[]
  branchesLoading: boolean
  base: string | null
  compare: string | null
  mode: DiffMode
  comparison: Comparison | null
  comparing: boolean
  preview: MergePreview | null
  previewing: boolean
  onBaseChange: (name: string) => void
  onCompareChange: (name: string) => void
  onModeChange: (mode: DiffMode) => void
  onCompare: () => void
  onPreviewMerge: () => void
  onPreviewReport: () => void
  onExportReport: () => void
  exporting: boolean
}

export function BranchCompare(props: BranchCompareProps) {
  const {
    repo, branches, branchesLoading, base, compare, mode,
    comparison, comparing, preview, previewing,
    onBaseChange, onCompareChange, onModeChange, onCompare, onPreviewMerge, onPreviewReport, onExportReport, exporting,
  } = props

  const [swapped, setSwapped] = useState(false)

  if (!repo) {
    return (
      <EmptyPanel
        title="No repository open"
        body="Open a local repository, then choose two branches to compare against their merge base."
      />
    )
  }

  if (branches.length === 0) {
    return (
      <EmptyPanel
        title="No branches to compare"
        body={
          branchesLoading
            ? 'Reading branches…'
            : repo.hasCommits
              ? 'This repository has no local branches.'
              : 'This repository has no commits yet, so there are no branches to compare.'
        }
      />
    )
  }

  const flip = () => {
    onBaseChange(compare ?? '')
    onCompareChange(base ?? '')
    setSwapped(!swapped)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2.5 p-4">
        <div className="flex items-end gap-2">
          <BranchSelect label="Base" value={base} branches={branches} onChange={onBaseChange} />
          <button
            type="button"
            onClick={flip}
            aria-label="Swap base and comparison branch"
            className="shrink-0 rounded-md border border-line bg-raised p-2 text-ink-muted transition-colors hover:text-ink"
          >
            <ArrowLeftRight className="size-3.5" aria-hidden />
          </button>
          <BranchSelect label="Compare" value={compare} branches={branches} onChange={onCompareChange} />
        </div>

        <div className="flex gap-1.5" role="group" aria-label="Comparison mode">
          <ModeButton active={mode === 'mergeBase'} onClick={() => onModeChange('mergeBase')}>
            From merge base
          </ModeButton>
          <ModeButton active={mode === 'direct'} onClick={() => onModeChange('direct')}>
            Tip to tip
          </ModeButton>
        </div>

        <button
          type="button"
          onClick={onCompare}
          disabled={comparing || !base || !compare}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-[12px] font-medium text-canvas transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {comparing ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <GitCompareArrows className="size-3.5" aria-hidden />
          )}
          Compare
        </button>

        <p className="text-[10px] leading-relaxed text-ink-faint">
          {mode === 'mergeBase' ? (
            <>
              Shows changes from the merge base to <span className="text-ink-muted">{compare}</span> —{' '}
              <span className="font-mono">base...{compare}</span>.
            </>
          ) : (
            <>
              Compares the two branch tips directly —{' '}
              <span className="font-mono">base {compare}</span>.
            </>
          )}{' '}
          Commits are always <span className="font-mono">base..{compare}</span>.
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim border-t border-line">
        {comparison ? (
          <ComparisonSummary
            comparison={comparison}
            preview={preview}
            previewing={previewing}
            onPreviewMerge={onPreviewMerge}
            flipped={swapped}
          />
        ) : (
          <p className="px-4 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
            Choose a base and a comparison branch, then select Compare.
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-line p-3">
        <button
          type="button"
          onClick={onPreviewReport}
          disabled={!comparison}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FileText className="size-3.5" aria-hidden />
          Preview report
        </button>
        <button
          type="button"
          onClick={onExportReport}
          disabled={!comparison || exporting}
          className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {exporting ? (
            <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Download className="size-3.5" aria-hidden />
          )}
          Export Markdown…
        </button>
      </div>
    </div>
  )
}

function ComparisonSummary({
  comparison,
  preview,
  previewing,
  onPreviewMerge,
  flipped,
}: {
  comparison: Comparison
  preview: MergePreview | null
  previewing: boolean
  onPreviewMerge: () => void
  flipped: boolean
}) {
  const { totals } = comparison

  return (
    <div className="space-y-3 p-4">
      <div>
        <p className="text-[11px] text-ink-faint">Direction</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-ink">
          <span className="font-mono">{flipped ? comparison.compare : comparison.base}</span>
          <ArrowLeftRight className="size-3 shrink-0 text-ink-faint" aria-hidden />
          <span className="font-mono">{flipped ? comparison.base : comparison.compare}</span>
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
        <Stat label="Merge base">
          {comparison.mergeBase ? (
            <span className="font-mono" title={comparison.mergeBaseSubject ?? ''}>
              {comparison.mergeBase.slice(0, 8)}
            </span>
          ) : (
            <span className="text-ink-faint">none (unrelated)</span>
          )}
        </Stat>
        <Stat label="Commits ahead">{comparison.ahead}</Stat>
        <Stat label="Commits behind">{comparison.behind}</Stat>
        <Stat label="Files changed">{totals.files}</Stat>
        <Stat label="Insertions">
          <span className="text-success">+{totals.insertions.toLocaleString()}</span>
        </Stat>
        <Stat label="Deletions">
          <span className="text-danger">-{totals.deletions.toLocaleString()}</span>
        </Stat>
      </dl>

      {comparison.overlapCount > 0 && (
        <div className="rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium text-warning">
            <TriangleAlert className="size-3 shrink-0" aria-hidden />
            {comparison.overlapCount} overlapping file
            {comparison.overlapCount === 1 ? '' : 's'}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">
            Modified on both sides since the merge base. Overlapping edits are a risk signal,{' '}
            <strong className="font-medium text-ink-muted">not</strong> a confirmed conflict —
            Git can often merge them automatically.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={onPreviewMerge}
        disabled={previewing || !comparison.mergeBase}
        className="flex w-full items-center justify-center gap-2 rounded-md border border-line bg-raised px-3 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-60"
      >
        {previewing ? (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <GitMerge className="size-3.5" aria-hidden />
        )}
        Run merge preview
      </button>

      {preview && (
        <div
          className={[
            'rounded-md border px-3 py-2.5',
            preview.clean ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5',
          ].join(' ')}
        >
          <p
            className={[
              'text-[11px] font-medium',
              preview.clean ? 'text-success' : 'text-danger',
            ].join(' ')}
          >
            {preview.clean ? 'No conflicts reported' : `${preview.conflicts.length} conflicting path(s)`}
          </p>
          <p className="mt-1 text-[10px] leading-relaxed text-ink-faint">{preview.message}</p>

          {preview.conflicts.length > 0 && (
            <ul className="mt-1.5 space-y-0.5">
              {preview.conflicts.slice(0, 8).map((c) => (
                <li key={c} className="truncate font-mono text-[10px] text-danger">
                  {c}
                </li>
              ))}
              {preview.conflicts.length > 8 && (
                <li className="text-[10px] text-ink-faint">+{preview.conflicts.length - 8} more</li>
              )}
            </ul>
          )}

          <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
            A preview is an estimate, never a guarantee that a future merge will succeed.
          </p>
        </div>
      )}
    </div>
  )
}

function BranchSelect({
  label,
  value,
  branches,
  onChange,
}: {
  label: string
  value: string | null
  branches: { name: string; isHead: boolean }[]
  onChange: (name: string) => void
}) {
  return (
    <label className="block min-w-0 flex-1 space-y-1">
      <span className="text-[10px] font-medium text-ink-muted">{label}</span>
      <div className="flex items-center gap-1.5 rounded-md border border-line bg-raised px-2 py-1.5">
        <GitBranch className="size-3 shrink-0 text-ink-faint" aria-hidden />
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          aria-label={`${label} branch`}
          className="w-full min-w-0 truncate bg-transparent text-[11px] text-ink focus:outline-none"
        >
          <option value="">Select…</option>
          {branches.map((b) => (
            <option key={b.name} value={b.name}>
              {b.name}
              {b.isHead ? ' (HEAD)' : ''}
            </option>
          ))}
        </select>
      </div>
    </label>
  )
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'flex-1 rounded-md px-2 py-1.5 text-[10px] transition-colors',
        active
          ? 'bg-raised text-ink'
          : 'border border-line text-ink-faint hover:text-ink-muted',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-[12px] text-ink">{children}</dd>
    </div>
  )
}