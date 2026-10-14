import type { Commit } from '../types'

/**
 * Assigns each commit a stable graph column using real parent hashes.
 *
 * Columns are **stable**: once a commit claims one, its mainline parent inherits
 * that same index, and the index is not shifted by later rows. Lanes are also
 * only reserved for parents that are actually present in the loaded set, so a
 * merge pointing at not-yet-loaded history cannot leave a dangling column.
 */
export interface GraphNode {
  commit: Commit
  /** Stable column this commit's node is drawn in. */
  lane: number
  /** Column of the previous row, for the horizontal connector. */
  prevLane: number | null
  /** Columns still carrying history downward after this row. */
  activeColumns: number[]
  /**
   * Column of every parent present in the loaded set, mainline first.
   * Any entry differing from `lane` needs a connector drawn to it — that covers
   * merges and also the converging case where two branches share a parent.
   */
  parentColumns: number[]
}

export function layoutGraph(commits: Commit[]): GraphNode[] {
  const nodes: GraphNode[] = []
  const present = new Set(commits.map((c) => c.hash))

  // `columns[i]` is the hash waiting to occupy column i, or null when free.
  const columns: (string | null)[] = []
  const freeColumns: number[] = []

  const allocate = (): number => {
    const reused = freeColumns.pop()
    if (reused !== undefined) return reused
    columns.push(null)
    return columns.length - 1
  }

  /**
   * Marks a column as holding `hash`. Removing it from the free list is the
   * critical part: a column that is occupied and listed as free would later be
   * handed out by `allocate` and silently destroy this reservation.
   */
  const occupy = (column: number, hash: string): void => {
    columns[column] = hash
    const at = freeColumns.indexOf(column)
    if (at !== -1) freeColumns.splice(at, 1)
  }

  const reserve = (hash: string): number => {
    const existing = columns.indexOf(hash)
    if (existing !== -1) return existing
    const column = allocate()
    occupy(column, hash)
    return column
  }

  const activeColumns = (): number[] => {
    const out: number[] = []
    for (let i = 0; i < columns.length; i += 1) {
      if (columns[i] !== null) out.push(i)
    }
    return out
  }

  let prevLane: number | null = null

  for (const commit of commits) {
    let lane = columns.indexOf(commit.hash)

    if (lane !== -1) {
      // Claim every column that was waiting for this commit, so a hash reserved
      // by more than one merge cannot leave an orphaned column behind.
      for (let i = 0; i < columns.length; i += 1) {
        if (columns[i] === commit.hash) {
          columns[i] = null
          if (!freeColumns.includes(i)) freeColumns.push(i)
        }
      }
    } else {
      // Nothing was waiting: a root commit, or the start of a branch whose
      // beginning is outside the loaded page.
      lane = allocate()
    }

    const mainline = commit.parents[0]
    const parentColumns: number[] = []

    if (mainline !== undefined && present.has(mainline)) {
      // The mainline parent normally inherits this commit's own column so
      // history runs straight down. If that column is unexpectedly taken, fall
      // back to any column already reserved for the parent.
      const already = columns.indexOf(mainline)
      if (already !== -1) {
        parentColumns.push(already)
      } else if (columns[lane] === null) {
        occupy(lane, mainline)
        parentColumns.push(lane)
      } else {
        parentColumns.push(reserve(mainline))
      }
    }

    // Each additional parent (a merge) occupies its own column.
    for (let i = 1; i < commit.parents.length; i += 1) {
      const parent = commit.parents[i]
      if (!present.has(parent)) continue
      parentColumns.push(reserve(parent))
    }

    // A root commit, or one whose parents are outside the loaded set, leaves
    // its column unused — return it so later branches can reuse it.
    if (columns[lane] === null && !freeColumns.includes(lane)) {
      freeColumns.push(lane)
    }

    nodes.push({ commit, lane, prevLane, activeColumns: activeColumns(), parentColumns })
    prevLane = lane
  }

  return nodes
}

/** Column colours, cycled so sibling branches stay visually distinct. */
export const LANE_COLORS = [
  '#4c9aff',
  '#35c98b',
  '#e5b567',
  '#f2637e',
  '#a78bfa',
  '#22d3ee',
  '#fb923c',
  '#94a3b8',
] as const

export function laneColor(lane: number): string {
  return LANE_COLORS[lane % LANE_COLORS.length]
}