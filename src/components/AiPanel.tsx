import {
  CircleAlert,
  CircleCheck,
  Download,
  LoaderCircle,
  Play,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import { EmptyPanel } from './CommitDetails'
import type {
  AiExplanation,
  AiRequestKind,
  Commit,
  CommitChanges,
  Comparison,
  FileDiff,
  OllamaModel,
  RepositoryInfo,
} from '../types'

interface AiPanelProps {
  repo: RepositoryInfo | null
  comparison: Comparison | null
  commit: Commit | null
  commitChanges: CommitChanges | null
  fileDiff: FileDiff | null

  state: AiState
  statusMessage: string | null
  errorMessage: string | null

  installed: boolean
  running: boolean
  installHint: string | null
  models: OllamaModel[]
  selectedModel: string
  warmUpOnStart: boolean

  busy: boolean
  explanation: AiExplanation | null

  onStartOllama: () => void
  onRetry: () => void
  onSelectModel: (model: string) => void
  onToggleWarmUp: (enabled: boolean) => void
  onWarmUp: () => void
  onExplain: (kind: AiRequestKind) => void
}

export type AiState = import('../types').AiState

const STATE_META: Record<
  AiState,
  { label: string; className: string; icon: typeof Sparkles }
> = {
  idle: { label: 'Idle', className: 'text-ink-faint', icon: Sparkles },
  checking: { label: 'Checking', className: 'text-ink-muted', icon: LoaderCircle },
  starting: { label: 'Starting Ollama', className: 'text-ink-muted', icon: LoaderCircle },
  loading: { label: 'Loading model', className: 'text-ink-muted', icon: LoaderCircle },
  ready: { label: 'Ready', className: 'text-success', icon: CircleCheck },
  unavailable: { label: 'Unavailable', className: 'text-warning', icon: TriangleAlert },
  error: { label: 'Error', className: 'text-danger', icon: CircleAlert },
}

export function AiPanel(props: AiPanelProps) {
  const {
    repo, comparison, commit, commitChanges, fileDiff,
    state, statusMessage, errorMessage,
    installed, running, installHint, models, selectedModel, warmUpOnStart,
    busy, explanation,
    onStartOllama, onRetry, onSelectModel, onToggleWarmUp, onWarmUp, onExplain,
  } = props

  if (!repo) {
    return (
      <EmptyPanel
        title="No repository open"
        body="Open a repository first. AI explanations always describe real commits from the selected repository."
      />
    )
  }

  const meta = STATE_META[state]
  const StateIcon = meta.icon
  const spinning = state === 'checking' || state === 'starting' || state === 'loading'
  const canExplain = state === 'ready' && !busy

  const hasBranchData = comparison !== null
  const hasCommitData = commit !== null

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2.5 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <StateIcon
            className={`size-3.5 shrink-0 ${meta.className} ${spinning ? 'animate-spin' : ''}`}
            aria-hidden
          />
          <span className={`text-[11px] font-medium ${meta.className}`}>{meta.label}</span>
          {running && (
            <span className="ml-auto truncate font-mono text-[10px] text-ink-faint">
              ollama {state === 'ready' ? 'ready' : 'local'}
            </span>
          )}
        </div>

        {(statusMessage ?? errorMessage) && (
          <p
            role={errorMessage ? 'alert' : undefined}
            className={`text-[10px] leading-relaxed ${errorMessage ? 'text-danger' : 'text-ink-faint'}`}
          >
            {errorMessage ?? statusMessage}
          </p>
        )}

        {installHint && (
          <div className="rounded-md border border-warning/30 bg-warning/5 px-2.5 py-2">
            <p className="text-[10px] leading-relaxed text-warning">
              The selected model is not downloaded. BranchMap will not download it for you.
            </p>
            <code className="mt-1 block select-all font-mono text-[10px] text-ink">
              {installHint}
            </code>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1.5 flex items-center gap-1.5 rounded border border-line px-2 py-1 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink"
            >
              <RefreshCw className="size-3" aria-hidden />
              Check again
            </button>
          </div>
        )}

        <div className="flex gap-1.5">
          {!running && installed && (
            <button
              type="button"
              onClick={onStartOllama}
              disabled={state === 'starting'}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-canvas transition-colors hover:bg-accent/85 disabled:opacity-60"
            >
              {state === 'starting' ? (
                <LoaderCircle className="size-3 animate-spin" aria-hidden />
              ) : (
                <Play className="size-3" aria-hidden />
              )}
              Start Ollama
            </button>
          )}

          {running && state !== 'ready' && (
            <button
              type="button"
              onClick={onRetry}
              disabled={state === 'checking'}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
            >
              <RefreshCw className="size-3" aria-hidden />
              Re-check
            </button>
          )}
        </div>

        <label className="block space-y-1">
          <span className="text-[10px] font-medium text-ink-muted">Model</span>
          <select
            value={selectedModel}
            onChange={(e) => onSelectModel(e.target.value)}
            aria-label="Ollama model"
            className="w-full rounded-md border border-line bg-raised px-2 py-1.5 text-[11px] text-ink focus:outline-none"
          >
            {/* Keep the configured default selectable even if not yet pulled. */}
            {!models.some((m) => m.name === selectedModel) && (
              <option value={selectedModel}>{selectedModel} (not installed)</option>
            )}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name} · {Math.round(m.size / 1_000_000)} MB
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-[10px] text-ink-faint">
          <input
            type="checkbox"
            checked={warmUpOnStart}
            onChange={(e) => onToggleWarmUp(e.target.checked)}
            className="accent-[var(--color-accent)]"
          />
          Warm up model at startup (uses memory and CPU)
        </label>

        {warmUpOnStart && state === 'ready' && (
          <button
            type="button"
            onClick={onWarmUp}
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-line px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:opacity-60"
          >
            <Zap className="size-3" aria-hidden />
            Warm up now
          </button>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-b border-line p-3">
        <button
          type="button"
          onClick={() => onExplain('branch')}
          disabled={!canExplain || !hasBranchData}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-accent px-2 py-1.5 text-[11px] font-medium text-canvas transition-colors hover:bg-accent/85 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3 animate-spin" aria-hidden /> : <Sparkles className="size-3" aria-hidden />}
          Explain branch comparison
        </button>

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => onExplain('commit')}
            disabled={!canExplain || !hasCommitData}
            className="rounded-md border border-line px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Explain commit
          </button>
          <button
            type="button"
            onClick={() => onExplain('risk')}
            disabled={!canExplain || !hasBranchData}
            className="rounded-md border border-line px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Change risk
          </button>
          <button
            type="button"
            onClick={() => onExplain('tests')}
            disabled={!canExplain || !hasBranchData}
            className="rounded-md border border-line px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Suggested tests
          </button>
          <button
            type="button"
            onClick={() => onExplain('branch')}
            disabled={!canExplain || !hasCommitData || !commitChanges}
            className="rounded-md border border-line px-2 py-1.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
          >
            Explain this commit
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-slim p-3">
        {explanation ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[10px] text-ink-faint">
              <span className="font-mono">{explanation.model}</span>
              <span>·</span>
              <span>{(explanation.elapsedMs / 1000).toFixed(1)}s</span>
              {explanation.truncated && <span className="text-warning">· truncated</span>}
            </div>
            {/* Model output is untrusted text: rendered as a text node, never HTML. */}
            <pre className="selectable whitespace-pre-wrap break-words font-sans text-[11px] leading-relaxed text-ink">
              {explanation.text}
            </pre>
          </div>
        ) : (
          <p className="text-[10px] leading-relaxed text-ink-faint">
            {hasBranchData || hasCommitData
              ? 'Pick an explanation above. Output is generated locally and is the model’s interpretation, not a Git fact.'
              : 'Run a branch comparison or select a commit first — explanations are grounded in real Git data only.'}
          </p>
        )}

        {fileDiff && !explanation && (
          <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-faint">
            <Download className="mt-px size-3 shrink-0" aria-hidden />
            A file diff is selected. “Explain this commit” includes a bounded excerpt of it.
          </p>
        )}
      </div>

      <div className="shrink-0 space-y-1.5 border-t border-line p-3">
        <p className="flex items-start gap-1.5 text-[10px] leading-relaxed text-ink-faint">
          <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden />
          Generated locally by Ollama. Repository text is untrusted input, and nothing is sent to a
          cloud provider. A merge preview is an estimate, never a guarantee.
        </p>
      </div>
    </div>
  )
}