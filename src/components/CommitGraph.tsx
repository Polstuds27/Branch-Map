import { GitCommitVertical, GitMerge, TriangleAlert } from 'lucide-react'
import { laneColor, layoutGraph } from '../lib/graph'
import { formatRelative } from '../lib/time'
import type { Commit, CommitPage, GitError } from '../types'

const LANE_WIDTH = 16
const ROW_HEIGHT = 34

interface CommitGraphProps {
  commits: Commit[]
  selectedHash: string | null
  onSelect: (hash: string) => void
}

/**
 * Renders real commits with lane lines derived from actual parent hashes.
 * Merges keep every parent lane so branch relationships stay visible.
 */
export function CommitGraph({ commits, selectedHash, onSelect }: CommitGraphProps) {
  const nodes = layoutGraph(commits)
  // One shared gutter width for every row keeps columns aligned down the list.
  const columnCount = Math.max(
    1,
    ...nodes.map((n) =>
      Math.max(
        n.lane + 1,
        n.prevLane === null ? 0 : n.prevLane + 1,
        ...n.activeColumns.map((c) => c + 1),
        ...n.parentColumns.map((c) => c + 1),
      ),
    ),
  )
  const gutter = columnCount * LANE_WIDTH

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-slim">
      <ul>
        {nodes.map((node) => {
          const { commit, lane, prevLane } = node
          const selected = commit.hash === selectedHash
          const color = laneColor(lane)
          const centerY = ROW_HEIGHT / 2

          return (
            <li key={commit.hash}>
              <button
                type="button"
                onClick={() => onSelect(commit.hash)}
                aria-current={selected}
                className={[
                  'flex w-full items-center gap-3 border-l-2 py-0 pr-3 text-left transition-colors',
                  selected
                    ? 'border-l-accent bg-raised'
                    : 'border-l-transparent hover:bg-raised/60',
                ].join(' ')}
                style={{ height: ROW_HEIGHT }}
              >
                <svg
                  width={gutter}
                  height={ROW_HEIGHT}
                  aria-hidden
                  className="shrink-0 overflow-visible"
                >
                  {/* Lanes that continue past this row. */}
                  {node.activeColumns.map((l) => (
                    <line
                      key={`lane-${l}`}
                      x1={l * LANE_WIDTH + LANE_WIDTH / 2}
                      y1={0}
                      x2={l * LANE_WIDTH + LANE_WIDTH / 2}
                      y2={ROW_HEIGHT}
                      stroke={laneColor(l)}
                      strokeWidth={2}
                      opacity={0.75}
                    />
                  ))}

                  {/* Connectors for any parent edge that does not run straight
                      down this column: merges, and branches that converge on a
                      shared parent. */}
                  {node.parentColumns
                    .filter((column) => column !== lane)
                    .map((column, index) => (
                      <line
                        key={`edge-${index}-${column}`}
                        x1={Math.min(lane, column) * LANE_WIDTH + LANE_WIDTH / 2}
                        y1={centerY}
                        x2={Math.max(lane, column) * LANE_WIDTH + LANE_WIDTH / 2}
                        y2={centerY}
                        stroke={color}
                        strokeWidth={2}
                        opacity={0.75}
                      />
                    ))}

                  {/* Horizontal bridge when the newest commit changed column. */}
                  {prevLane !== null && prevLane !== lane && (
                    <line
                      x1={prevLane * LANE_WIDTH + LANE_WIDTH / 2}
                      y1={centerY}
                      x2={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      y2={centerY}
                      stroke={color}
                      strokeWidth={2}
                      opacity={0.75}
                    />
                  )}

                  {commit.isMerge ? (
                    <>
                      <circle
                        cx={lane * LANE_WIDTH + LANE_WIDTH / 2}
                        cy={centerY}
                        r={5}
                        fill="#0a0e14"
                        stroke={color}
                        strokeWidth={2}
                      />
                      <circle
                        cx={lane * LANE_WIDTH + LANE_WIDTH / 2}
                        cy={centerY}
                        r={2}
                        fill={color}
                      />
                    </>
                  ) : (
                    <circle
                      cx={lane * LANE_WIDTH + LANE_WIDTH / 2}
                      cy={centerY}
                      r={4}
                      fill={color}
                      stroke="#0a0e14"
                      strokeWidth={1.5}
                    />
                  )}
                </svg>

                <span className="selectable w-16 shrink-0 font-mono text-[11px] text-ink-muted">
                  {commit.shortHash}
                </span>

                <span className="flex min-w-0 flex-1 items-center gap-2">
                  {commit.decorations.map((decoration) => (
                    <span
                      key={decoration}
                      className="max-w-40 shrink-0 truncate rounded border border-accent-soft bg-accent-soft/40 px-1.5 py-px font-mono text-[10px] text-accent"
                      title={decoration}
                    >
                      {decoration}
                    </span>
                  ))}
                  {/* `min-w-0` is required for truncation: without it a long
                      subject sets the row's min-content width and stretches the
                      whole layout, pushing the inspector panel off-screen. */}
                  <span className="min-w-0 truncate text-[12px] text-ink">
                    {commit.subject}
                  </span>
                </span>

                {commit.isMerge && (
                  <GitMerge className="size-3.5 shrink-0 text-ink-faint" aria-label="merge commit" />
                )}

                <span className="hidden w-28 shrink-0 truncate text-[11px] text-ink-muted sm:block">
                  {commit.authorName}
                </span>
                <span className="hidden w-24 shrink-0 text-right text-[11px] text-ink-faint md:block">
                  {formatRelative(commit.authoredAt)}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

interface CommitHistoryStatesProps {
  page: CommitPage | null
  loading: boolean
  error: GitError | null
  onRetry: () => void
}

/** Empty / loading / error surfaces that wrap the graph. */
export function CommitHistoryStates({ page, loading, error, onRetry }: CommitHistoryStatesProps) {
  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-ink-faint">
        <GitCommitVertical className="size-6 animate-pulse" aria-hidden />
        <p className="text-[12px]">Reading commit history…</p>
      </div>
    )
  }

  if (error) {
    return (
      <div
        role="alert"
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <TriangleAlert className="size-6 text-danger" aria-hidden />
        <p className="text-[13px] font-medium text-ink-muted">{error.message}</p>
        {error.hint && <p className="max-w-sm text-[11px] text-ink-faint">{error.hint}</p>}
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-md border border-line bg-raised px-3 py-1.5 text-[12px] text-ink transition-colors hover:border-accent"
        >
          Try again
        </button>
      </div>
    )
  }

  if (page && page.commits.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <GitCommitVertical className="size-6 text-ink-faint" aria-hidden />
        <p className="text-[13px] font-medium text-ink-muted">No commits yet</p>
        <p className="max-w-sm text-[11px] leading-relaxed text-ink-faint">
          This repository has an unborn HEAD. Make an initial commit in your terminal, then refresh.
        </p>
      </div>
    )
  }

  return null
}

export { LANE_WIDTH, ROW_HEIGHT }