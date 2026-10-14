import type { Comparison, FileChange, FileStatus, MergePreview } from '../types'

const STATUS_LABEL: Record<FileStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typeChanged: 'Type changed',
  unmerged: 'Unmerged',
  unknown: 'Changed',
}

/**
 * Repository-controlled text (branch names, subjects, paths) is untrusted input.
 * Control characters are replaced with spaces so a crafted commit message
 * cannot corrupt the report's structure, and table cells escape pipes so a path
 * containing `|` cannot break the table.
 */
function clean(value: string): string {
  // Matching control characters here is deliberate: repository text must not
  // be able to inject newlines or escape codes into the generated report.
  // oxlint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim()
}

function cell(value: string): string {
  return clean(value).replace(/\|/g, '\\|')
}

function code(value: string): string {
  const cleaned = clean(value)
  // Use a longer fence when the value itself contains backticks.
  const fence = cleaned.includes('`') ? '``' : '`'
  return `${fence}${cleaned}${fence}`
}

/**
 * Inline code for a **table cell**. Pipes are legal in Git paths, so they must
 * be escaped or a crafted filename would split the row into extra columns.
 */
function codeCell(value: string): string {
  return code(value).replace(/\|/g, '\\|')
}

export interface ReportInput {
  repoName: string
  comparison: Comparison
  preview: MergePreview | null
  generatedAt: Date
}

export function buildChangeReport({
  repoName,
  comparison,
  preview,
  generatedAt,
}: ReportInput): string {
  const { totals } = comparison
  const out: string[] = []

  out.push(`# Change report — ${clean(repoName)}`)
  out.push('')
  out.push(
    `Generated ${clean(generatedAt.toLocaleString())} by BranchMap from local Git data. ` +
      'No repository content left this machine.',
  )
  out.push('')

  out.push('## Comparison')
  out.push('')
  out.push(`- Base: ${code(comparison.base)}`)
  out.push(`- Compared with: ${code(comparison.compare)}`)
  out.push(
    comparison.mode === 'direct'
      ? '- Mode: tip to tip (`git diff base compare`) — the two branch tips compared directly.'
      : '- Mode: from merge base (`git diff base...compare`) — what changed on the comparison branch since it forked.',
  )
  out.push(
    `- Commits listed: \`base..compare\` — ${comparison.ahead} ahead, ${comparison.behind} behind`,
  )
  out.push('')

  out.push('## Merge base')
  out.push('')
  if (comparison.mergeBase) {
    out.push(
      `- ${code(comparison.mergeBase)}${comparison.mergeBaseSubject ? ` — ${cell(comparison.mergeBaseSubject)}` : ''}`,
    )
  } else {
    out.push('- No merge base: these branches have no common ancestor.')
  }
  out.push('')

  out.push('## Totals')
  out.push('')
  out.push(`- Files changed: ${totals.files}`)
  out.push(`- Insertions: +${totals.insertions.toLocaleString()}`)
  out.push(`- Deletions: -${totals.deletions.toLocaleString()}`)
  if (totals.binaryFiles > 0) {
    out.push(`- Binary files: ${totals.binaryFiles} (Git reports no line counts for these)`)
  }
  out.push('')

  const overlapping = comparison.files.filter((f) => f.overlap)
  out.push('## Overlapping changed paths')
  out.push('')
  if (overlapping.length === 0) {
    out.push('- No files were modified on both sides since the merge base.')
  } else {
    out.push(
      `${overlapping.length} path(s) were modified on **both** sides since the merge base. ` +
        '**This is an overlap indicator, not a confirmed conflict** — Git often merges overlapping edits cleanly.',
    )
    out.push('')
    for (const file of overlapping) out.push(`- ${code(file.path)} (${STATUS_LABEL[file.status]})`)
  }
  out.push('')

  out.push('## Merge preview')
  out.push('')
  if (!preview) {
    out.push('- Not run for this comparison.')
  } else if (preview.clean) {
    out.push('- Git reported no conflicts for this merge.')
  } else {
    out.push(`- Git reported ${preview.conflicts.length} conflicting path(s):`)
    for (const path of preview.conflicts.slice(0, 50)) out.push(`  - ${code(path)}`)
    if (preview.conflicts.length > 50) {
      out.push(`  - …and ${preview.conflicts.length - 50} more`)
    }
  }
  out.push('')
  out.push('> A merge preview is an **estimate**, not a guarantee that a future merge will succeed.')
  out.push("> It reflects only the current revisions; later changes can still conflict. Git's")
  out.push('> `merge-tree --write-tree` also writes temporary tree objects to the object')
  out.push('> database (refs, index, and working tree are untouched).')
  out.push('')

  out.push('## Changed files')
  out.push('')
  if (comparison.files.length === 0) {
    out.push('_No file differences between these revisions._')
  } else {
    out.push('| Status | File | + | - |')
    out.push('| --- | --- | ---: | ---: |')
    for (const file of comparison.files) out.push(fileRow(file))
  }
  out.push('')

  out.push(...suggestTests(comparison))
  out.push('')
  out.push('---')
  out.push(
    'All figures above come from the local Git CLI. BranchMap performs **read-only** ' +
      'inspection; nothing was committed, merged, or pushed.',
  )

  return out.join('\n')
}

function fileRow(file: FileChange): string {
  const name =
    file.oldPath && file.oldPath !== file.path
      ? `${codeCell(file.oldPath)} → ${codeCell(file.path)}`
      : codeCell(file.path)
  const plus = file.binary ? '—' : `+${file.insertions ?? 0}`
  const minus = file.binary ? '—' : `-${file.deletions ?? 0}`
  return `| ${STATUS_LABEL[file.status]} | ${name} | ${plus} | ${minus} |`
}

/**
 * Derives **suggested** verification steps from what actually changed.
 * These are suggestions only — BranchMap does not run any test suite.
 */
function suggestTests(comparison: Comparison): string[] {
  const out: string[] = ['## Suggested tests', '']
  out.push(
    '> These are **suggestions only**. BranchMap did not run them and cannot confirm ' +
      'that any of them pass.',
  )
  out.push('')

  const paths = comparison.files.map((f) => f.path.toLowerCase())
  const has = (predicate: (p: string) => boolean) => paths.some(predicate)
  const suggestions: string[] = []

  const testFiles = comparison.files.filter((f) =>
    /(^|\/)(tests?|__tests__|spec)\//.test(f.path.toLowerCase()),
  )
  if (testFiles.length > 0) {
    suggestions.push(
      `Run the test files this change touches: ${testFiles
        .slice(0, 5)
        .map((f) => code(f.path))
        .join(', ')}`,
    )
  }
  if (has((p) => p.endsWith('package.json') || p.endsWith('package-lock.json'))) {
    suggestions.push('`package.json` changed — reinstall dependencies and confirm the build still succeeds.')
  }
  if (has((p) => p.endsWith('requirements.txt') || p.endsWith('pyproject.toml'))) {
    suggestions.push('Python dependency metadata changed — re-resolve the environment before testing.')
  }
  if (has((p) => p.includes('migration'))) {
    suggestions.push(
      'Database migrations changed — apply them to a scratch database and confirm the schema still loads.',
    )
  }
  if (has((p) => p.endsWith('.yml') || p.endsWith('.yaml') || p.includes('workflows'))) {
    suggestions.push('CI/workflow files changed — validate the YAML and check the pipeline definition.')
  }
  if (has((p) => /\.(png|jpe?g|gif|pdf|zip|ico|woff2?)$/.test(p))) {
    suggestions.push('Binary assets changed — confirm they render where they are used.')
  }
  if (has((p) => p.endsWith('.env.example') || p.includes('config'))) {
    suggestions.push('Configuration changed — verify the app still starts with default settings.')
  }

  suggestions.push('Run the existing test suite for the affected area before merging.')

  const overlapping = comparison.files.filter((f) => f.overlap)
  if (overlapping.length > 0) {
    suggestions.push(
      `Review the ${overlapping.length} overlapping path(s) by hand — both sides changed them, so behaviour deserves a deliberate look.`,
    )
  }

  for (const suggestion of suggestions) out.push(`- ${suggestion}`)
  return out
}