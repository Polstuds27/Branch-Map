import { ArrowRight, Copy, FileDiff, Pencil, Plus, TriangleAlert, Trash2, Type } from 'lucide-react'
import { DiffView } from './DiffView'
import type { FileChange, FileDiff as FileDiffPayload, FileStatus } from '../types'

interface DiffExplorerProps {
  /** Short description of what the file list represents, e.g. the comparison mode. */
  caption?: string
  files: FileChange[]
  additions: number
  deletions: number
  binaryFiles: number
  /** False when the source (e.g. a combined diff) reports no line counts. */
  statsAvailable: boolean
  selectedFile: string | null
  diff: FileDiffPayload | null
  diffLoading: boolean
  diffError: string | null
  onSelectFile: (path: string) => void
}

const STATUS_META: Record<FileStatus, { label: string; icon: typeof Plus; className: string }> = {
  added: { label: 'Added', icon: Plus, className: 'text-success' },
  modified: { label: 'Modified', icon: Pencil, className: 'text-warning' },
  deleted: { label: 'Deleted', icon: Trash2, className: 'text-danger' },
  renamed: { label: 'Renamed', icon: ArrowRight, className: 'text-accent' },
  copied: { label: 'Copied', icon: Copy, className: 'text-accent' },
  typeChanged: { label: 'Type changed', icon: Type, className: 'text-warning' },
  unmerged: { label: 'Unmerged', icon: TriangleAlert, className: 'text-danger' },
  unknown: { label: 'Changed', icon: FileDiff, className: 'text-ink-muted' },
}

/** File list plus the unified diff for the selected path. */
export function DiffExplorer({
  caption,
  files,
  additions,
  deletions,
  binaryFiles,
  statsAvailable,
  selectedFile,
  diff,
  diffLoading,
  diffError,
  onSelectFile,
}: DiffExplorerProps) {
  const selected = files.find((f) => f.path === selectedFile) ?? null

  return (
    <section
      aria-label="Changed files and diff"
      className="flex h-[46%] min-h-0 shrink-0 flex-col border-t border-line bg-surface"
    >
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-line px-3">
        <span className="text-[11px] font-medium text-ink-muted">
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        {statsAvailable ? (
          <>
            <span className="text-[11px] text-success">+{additions.toLocaleString()}</span>
            <span className="text-[11px] text-danger">-{deletions.toLocaleString()}</span>
          </>
        ) : (
          <span className="text-[11px] text-ink-faint">no line stats</span>
        )}
        {binaryFiles > 0 && (
          <span className="text-[11px] text-ink-faint">{binaryFiles} binary</span>
        )}

        {caption && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint" title={caption}>
            {caption}
          </span>
        )}

        {selected && (
          <span
            className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-ink-muted"
            title={selected.path}
          >
            {selected.path}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <ul className="w-72 shrink-0 overflow-y-auto scrollbar-slim border-r border-line py-1">
          {files.length === 0 && (
            <li className="px-3 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
              No file differences to show.
            </li>
          )}

          {files.map((file) => (
            <li key={file.path}>
              <FileRow
                file={file}
                selected={file.path === selectedFile}
                onSelect={() => onSelectFile(file.path)}
              />
            </li>
          ))}
        </ul>

        <div className="flex min-w-0 flex-1 flex-col">
          <DiffView file={diff} loading={diffLoading} error={diffError} />
        </div>
      </div>
    </section>
  )
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  file: FileChange
  selected: boolean
  onSelect: () => void
}) {
  const meta = STATUS_META[file.status] ?? STATUS_META.unknown
  const Icon = meta.icon
  const name = file.path.split(/[\\/]/).pop() ?? file.path
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected}
      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
      className={[
        'flex w-full items-center gap-2 border-l-2 px-3 py-1.5 text-left transition-colors',
        selected ? 'border-l-accent bg-raised' : 'border-l-transparent hover:bg-raised/60',
      ].join(' ')}
    >
      <Icon className={`size-3.5 shrink-0 ${meta.className}`} aria-label={meta.label} />

      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12px] text-ink">{name}</span>
        {dir && <span className="truncate text-[10px] text-ink-faint">{dir}</span>}
      </span>

      {file.overlap && (
        <span
          title="Modified on both sides since the merge base — not a confirmed conflict"
          className="shrink-0 rounded bg-warning/15 px-1 py-px text-[9px] font-medium uppercase text-warning"
        >
          overlap
        </span>
      )}

      <span className="shrink-0 whitespace-nowrap font-mono text-[10px]">
        {file.binary ? (
          <span className="text-ink-faint">bin</span>
        ) : (
          <>
            <span className="text-success">+{file.insertions ?? 0}</span>{' '}
            <span className="text-danger">-{file.deletions ?? 0}</span>
          </>
        )}
      </span>
    </button>
  )
}