import { X } from 'lucide-react'

interface ReportModalProps {
  markdown: string
  onClose: () => void
}

/**
 * Shows the generated Markdown as plain text. The content includes
 * repository-controlled strings (branch names, subjects, paths), so it is
 * rendered inside a <pre> — React escapes it and it is never treated as HTML.
 */
export function ReportModal({ markdown, onClose }: ReportModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      role="dialog"
      aria-modal="true"
      aria-label="Change report preview"
    >
      <div className="flex h-full max-h-[85vh] w-full max-w-4xl flex-col rounded-lg border border-line bg-surface shadow-2xl">
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line px-4">
          <h2 className="text-[13px] font-semibold">Change report preview</h2>
          <span className="text-[11px] text-ink-faint">
            Generated from local Git data · {markdown.length.toLocaleString()} characters
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close report preview"
            className="ml-auto rounded p-1 text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <pre className="selectable min-h-0 flex-1 overflow-auto scrollbar-slim whitespace-pre-wrap break-words p-4 font-mono text-[11px] leading-relaxed text-ink">
          {markdown}
        </pre>
      </div>
    </div>
  )
}