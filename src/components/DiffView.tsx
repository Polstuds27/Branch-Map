import { FileDiff } from 'lucide-react'
import type { FileDiff as FileDiffPayload } from '../types'

interface DiffViewProps {
  file: FileDiffPayload | null
  loading: boolean
  error: string | null
}

const MAX_RENDERED_LINES = 4000

/**
 * Renders a unified diff as text nodes only. Repository content is untrusted
 * input, so it is never injected as HTML — React escapes every line here.
 */
export function DiffView({ file, loading, error }: DiffViewProps) {
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-faint">
        Loading diff…
      </div>
    )
  }

  if (error) {
    return (
      <p role="alert" className="p-4 text-[12px] leading-relaxed text-danger">
        {error}
      </p>
    )
  }

  if (!file) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileDiff className="size-5 text-ink-faint" aria-hidden />
        <p className="text-[12px] text-ink-muted">Select a file to see its diff</p>
      </div>
    )
  }

  if (file.binary) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <FileDiff className="size-5 text-ink-faint" aria-hidden />
        <p className="text-[12px] font-medium text-ink-muted">Binary file</p>
        <p className="max-w-xs text-[11px] leading-relaxed text-ink-faint">
          Git reports no line-level changes for binary content, so no textual diff is available.
        </p>
      </div>
    )
  }

  if (file.diff.trim() === '') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-[12px] font-medium text-ink-muted">No textual changes</p>
        <p className="max-w-xs text-[11px] leading-relaxed text-ink-faint">
          This file differs only in mode or is otherwise unchanged between the two revisions.
        </p>
      </div>
    )
  }

  const lines = file.diff.split('\n')
  // Guard the render cost: a huge diff is truncated rather than freezing the UI.
  const shown = lines.slice(0, MAX_RENDERED_LINES)
  const hidden = lines.length - shown.length

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-slim">
      <table className="w-full border-collapse font-mono text-[11px] leading-relaxed">
        <tbody>
          {shown.map((line, index) => {
            const kind = classify(line)
            return (
              <tr
                key={index}
                className={[
                  'align-top',
                  kind === 'add' ? 'bg-success/10' : '',
                  kind === 'del' ? 'bg-danger/10' : '',
                  kind === 'hunk' ? 'bg-accent-soft/40' : '',
                  kind === 'meta' ? 'text-ink-faint' : '',
                ].join(' ')}
              >
                <td className="selectable w-10 shrink-0 border-r border-line px-2 py-0 text-right align-top text-ink-faint">
                  {index + 1}
                </td>
                <td
                  className={[
                    'w-4 shrink-0 select-none px-1 text-center align-top',
                    kind === 'add' ? 'text-success' : '',
                    kind === 'del' ? 'text-danger' : '',
                  ].join(' ')}
                >
                  {kind === 'add' ? '+' : kind === 'del' ? '-' : ''}
                </td>
                <td className="selectable whitespace-pre-wrap break-words px-2 py-0">
                  {line.replace(/^\+/, '').replace(/^-/, '') || ' '}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {(hidden > 0 || file.truncated) && (
        <p className="border-t border-line px-3 py-2 text-[11px] text-warning">
          {file.truncated
            ? 'Diff truncated for display — this file is larger than the viewer limit.'
            : `${hidden.toLocaleString()} more line(s) not rendered.`}
        </p>
      )}
    </div>
  )
}

type LineKind = 'add' | 'del' | 'hunk' | 'meta' | 'context'

function classify(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ||
      line.startsWith('index ') || line.startsWith('new file') ||
      line.startsWith('deleted file') || line.startsWith('similarity index') ||
      line.startsWith('rename ') || line.startsWith('copy ') ||
      line.startsWith('old mode') || line.startsWith('new mode') ||
      line.startsWith('Binary files')) {
    return 'meta'
  }
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'context'
}