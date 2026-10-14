import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { open as openDialog } from '@tauri-apps/plugin-dialog'

import { Sidebar } from './components/Sidebar'
import { TitleBar } from './components/TitleBar'
import { StatusBar } from './components/StatusBar'
import { RepoSummaryStrip, WelcomeView } from './components/WelcomeView'
import { WorkspaceToolbar, type PanelKey } from './components/WorkspaceToolbar'
import { CommitHistory } from './components/CommitHistory'
import { CommitDetails } from './components/CommitDetails'
import { BranchCompare } from './components/BranchCompare'
import { DiffExplorer } from './components/DiffExplorer'
import { ReportModal } from './components/ReportModal'
import { AiPanel } from './components/AiPanel'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import {
  compareBranches,
  getCommitChanges,
  getCommitDiff,
  getGitInstallation,
  getFileDiff,
  listBranches,
  listCommits,
  previewMerge,
  validateRepository,
  writeTextFile,
} from './services/git'
import { buildChangeReport } from './lib/report'
import { buildCommitRequest, buildComparisonRequest } from './lib/aiRequests'
import {
  explainWithModel,
  getDefaultModel,
  getOllamaStatus,
  startOllama,
  warmUpModel,
} from './services/ollama'
import { toGitError } from './types'
import type {
  AiExplanation,
  AiRequest,
  AiRequestKind,
  AiState,
  BranchList,
  Commit,
  CommitChanges,
  CommitPage,
  CommitParentMode,
  Comparison,
  DiffMode,
  FileDiff,
  GitInstallation,
  GitError,
  MergePreview,
  OllamaModel,
  RepositoryInfo,
} from './types'

const RECENT_KEY = 'branchmap.recent'
const LAST_REPO_KEY = 'branchmap.lastRepo'
const AI_MODEL_KEY = 'branchmap.ai.model'
const AI_WARMUP_KEY = 'branchmap.ai.warmup'
const PAGE_SIZE = 200

/** Recent paths are a local convenience list only — no telemetry, no sync. */
function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

export default function App() {
  const [git, setGit] = useState<GitInstallation | null>(null)
  const [repo, setRepo] = useState<RepositoryInfo | null>(null)
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<GitError | null>(null)
  const [panel, setPanel] = useState<PanelKey>('details')
  const [commits, setCommits] = useState<Commit[]>([])
  const [page, setPage] = useState<CommitPage | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [historyError, setHistoryError] = useState<GitError | null>(null)
  const [selectedHash, setSelectedHash] = useState<string | null>(null)

  // Branch comparison state
  const [branchList, setBranchList] = useState<BranchList | null>(null)
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [baseBranch, setBaseBranch] = useState<string | null>(null)
  const [compareBranch, setCompareBranch] = useState<string | null>(null)
  const [diffMode, setDiffMode] = useState<DiffMode>('mergeBase')
  const [comparison, setComparison] = useState<Comparison | null>(null)
  const [comparing, setComparing] = useState(false)
  const [mergePreview, setMergePreview] = useState<MergePreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  // Per-commit changes
  const [commitChanges, setCommitChanges] = useState<CommitChanges | null>(null)
  const [changesLoading, setChangesLoading] = useState(false)
  const [parentMode, setParentMode] = useState<CommitParentMode>('firstParent')
  const [commitDiff, setCommitDiff] = useState<FileDiff | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const [commitDiffError, setCommitDiffError] = useState<string | null>(null)
  const [selectedCommitFile, setSelectedCommitFile] = useState<string | null>(null)

  // Report
  const [reportPreview, setReportPreview] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  // Local AI (Ollama). Initialisation is deliberately asynchronous so Git
  // features stay usable while it starts.
  const [aiState, setAiState] = useState<AiState>('idle')
  const [aiInstalled, setAiInstalled] = useState(false)
  const [aiRunning, setAiRunning] = useState(false)
  const [aiModels, setAiModels] = useState<OllamaModel[]>([])
  const [aiInstallHint, setAiInstallHint] = useState<string | null>(null)
  const [aiSelectedModel, setAiSelectedModel] = useState<string>('qwen2.5:0.5b')
  const [aiWarmUpOnStart, setAiWarmUpOnStart] = useState(
    () => localStorage.getItem(AI_WARMUP_KEY) === 'true',
  )
  const [aiBusy, setAiBusy] = useState(false)
  const [aiExplanation, setAiExplanation] = useState<AiExplanation | null>(null)
  const [aiError, setAiError] = useState<string | null>(null)
  const [aiStatus, setAiStatus] = useState<string | null>(null)
  // Guards against overlapping inferences even if the UI is bypassed. Each
  // request holds a model in memory, so stacking them can exhaust RAM.
  const aiInFlight = useRef(false)
  // Sequence counter for readiness checks. Without it, a slow response for an
  // older model can land after a newer check and overwrite its state.
  const aiCheckSeq = useRef(0)
  // Mirrors the selected model so async callbacks can detect a mid-flight change
  // without capturing a stale closure value.
  const aiSelectedModelRef = useRef(aiSelectedModel)
  // Tags the newest history request so a slow earlier response cannot
  // overwrite a newer repository's commits.
  const historyRequest = useRef(0)
  // `isTauri()` is synchronous, so it is resolved during initialisation rather
  // than in an effect — no cascading render needed.
  const [inTauri] = useState(() => isTauri())

  // The commit currently selected in the graph, derived from loaded history.
  const selectedCommit = useMemo(
    () => commits.find((c) => c.hash === selectedHash) ?? null,
    [commits, selectedHash],
  )

  useEffect(() => {
    getGitInstallation()
      .then(setGit)
      .catch((err) => setError(toGitError(err)))
  }, [])

  /**
   * Startup: restore the last repository and probe AI readiness.
   * Both are asynchronous so the window is usable immediately, and neither is
   * allowed to block Git features.
   */
  useEffect(() => {
    let cancelled = false

    // AI readiness: a cheap status probe. Nothing is downloaded and the model is
    // only warmed up when the user has explicitly enabled it.
    void (async () => {
      let model = localStorage.getItem(AI_MODEL_KEY)
      if (!model) {
        try {
          model = await getDefaultModel()
        } catch {
          model = 'qwen2.5:0.5b'
        }
      }
      if (cancelled) return
      aiSelectedModelRef.current = model
      setAiSelectedModel(model)

      await checkAi(model)
      if (cancelled) return

      if (aiWarmUpOnStart) {
        try {
          const status = await getOllamaStatus(model)
          if (status.running && status.selectedModelAvailable) {
            await warmUpModel(model)
            if (!cancelled) setAiState('ready')
          }
        } catch {
          // A failed warm-up must never stop the app from working.
        }
      }
    })()

    // Restore the last repository without blocking the UI.
    const lastRepo = localStorage.getItem(LAST_REPO_KEY)
    if (lastRepo) void openPath(lastRepo)

    return () => {
      cancelled = true
    }
    // Runs once on mount; openPath/checkAi are stable enough for startup.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remember = useCallback((path: string) => {
    setRecent((prev) => {
      const next = [path, ...prev.filter((p) => p !== path)].slice(0, 8)
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next))
      } catch {
        // A failed recent-list write must never break opening a repository.
      }
      return next
    })
  }, [])

  /** Loads one page of real history. `append` keeps already-loaded commits. */
  const loadHistory = useCallback(
    async (path: string, skip: number, append: boolean) => {
      const requestId = historyRequest.current + 1
      historyRequest.current = requestId

      if (append) setLoadingMore(true)
      else setHistoryLoading(true)
      setHistoryError(null)

      try {
        const result = await listCommits(path, PAGE_SIZE, skip)
        if (historyRequest.current !== requestId) return

        setPage(result)
        setCommits((prev) => (append ? [...prev, ...result.commits] : result.commits))
        setSelectedHash((current) =>
          result.commits.some((c) => c.hash === current) || append ? current : null,
        )
      } catch (err) {
        if (historyRequest.current !== requestId) return
        setHistoryError(toGitError(err))
        if (!append) {
          setCommits([])
          setPage(null)
        }
      } finally {
        if (historyRequest.current === requestId) {
          setHistoryLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [],
  )

  /** Loads branches and picks sensible defaults (HEAD as compare, first other as base). */
  const loadBranches = useCallback(async (path: string) => {
    setBranchesLoading(true)
    try {
      const result = await listBranches(path)
      setBranchList(result)

      setBaseBranch((prev) => {
        if (prev && result.branches.some((b) => b.name === prev)) return prev
        const other = result.branches.find((b) => !b.isHead)
        return other?.name ?? result.branches[0]?.name ?? null
      })
      setCompareBranch((prev) => {
        if (prev && result.branches.some((b) => b.name === prev)) return prev
        return result.head ?? result.branches[0]?.name ?? null
      })
    } catch (err) {
      setError(toGitError(err))
      setBranchList(null)
    } finally {
      setBranchesLoading(false)
    }
  }, [])

  const runComparison = useCallback(
    async (path: string, base: string, compare: string, mode: DiffMode) => {
      setComparing(true)
      setDiffError(null)
      try {
        const result = await compareBranches(path, base, compare, mode)
        setComparison(result)
        setMergePreview(null)
        setSelectedFile(null)
        setFileDiff(null)
        // Open the first changed file so the explorer is never empty by accident.
        const first = result.files[0]
        if (first) {
          setSelectedFile(first.path)
          setDiffLoading(true)
          try {
            setFileDiff(await getFileDiff(path, base, compare, first.path, mode))
          } catch (err) {
            setDiffError(toGitError(err).message)
          } finally {
            setDiffLoading(false)
          }
        }
      } catch (err) {
        setComparison(null)
        setError(toGitError(err))
      } finally {
        setComparing(false)
      }
    },
    [],
  )

  const selectFile = useCallback(
    async (path: string) => {
      if (!repo || !baseBranch || !compareBranch) return
      setSelectedFile(path)
      setDiffLoading(true)
      setDiffError(null)
      try {
        setFileDiff(await getFileDiff(repo.root, baseBranch, compareBranch, path, diffMode))
      } catch (err) {
        setFileDiff(null)
        setDiffError(toGitError(err).message)
      } finally {
        setDiffLoading(false)
      }
    },
    [repo, baseBranch, compareBranch, diffMode],
  )

  const runMergePreview = useCallback(async () => {
    if (!repo || !baseBranch || !compareBranch) return
    setPreviewing(true)
    try {
      setMergePreview(await previewMerge(repo.root, baseBranch, compareBranch))
    } catch (err) {
      setError(toGitError(err))
    } finally {
      setPreviewing(false)
    }
  }, [repo, baseBranch, compareBranch])

  /** Probes Ollama and maps the result onto the UI state machine. */
  const checkAi = useCallback(
    async (model: string, showChecking = true) => {
      const seq = aiCheckSeq.current + 1
      aiCheckSeq.current = seq
      if (showChecking) setAiState('checking')
      setAiError(null)
      try {
        const status = await getOllamaStatus(model)
        // A newer check has already been issued: this result is stale.
        if (aiCheckSeq.current !== seq) return

        setAiInstalled(status.installed)
        setAiRunning(status.running)
        setAiModels(status.models)
        setAiInstallHint(status.installHint ?? null)
        setAiStatus(status.message ?? null)

        // Refresh the data, but never overwrite the `loading` state of an
        // inference that is still running — doing so re-enabled the action
        // buttons while a request was in flight.
        if (aiInFlight.current) return

        if (!status.installed) setAiState('unavailable')
        else if (!status.running) setAiState('unavailable')
        else if (!status.selectedModelAvailable) setAiState('unavailable')
        else setAiState('ready')
      } catch (err) {
        if (aiCheckSeq.current !== seq) return
        if (aiInFlight.current) return
        setAiState('error')
        setAiError(toGitError(err).message)
      }
    },
    [],
  )

  const startAi = useCallback(async () => {
    setAiState('starting')
    setAiError(null)
    try {
      const status = await startOllama(aiSelectedModel)
      setAiInstalled(status.installed)
      setAiRunning(status.running)
      setAiModels(status.models)
      setAiInstallHint(status.installHint ?? null)
      setAiStatus(status.message ?? null)
      setAiState(status.running && status.selectedModelAvailable ? 'ready' : 'unavailable')
    } catch (err) {
      setAiState('error')
      setAiError(toGitError(err).message)
    }
  }, [aiSelectedModel])

  const warmUpAi = useCallback(async () => {
    setAiState('loading')
    setAiError(null)
    try {
      await warmUpModel(aiSelectedModel)
      setAiState('ready')
      setAiStatus('Model warmed up and ready.')
    } catch (err) {
      setAiState('error')
      setAiError(toGitError(err).message)
    }
  }, [aiSelectedModel])

  const selectAiModel = useCallback((model: string) => {
    aiSelectedModelRef.current = model
    setAiSelectedModel(model)
    localStorage.setItem(AI_MODEL_KEY, model)
    setAiExplanation(null)
    void checkAi(model)
  }, [checkAi])

  const toggleAiWarmUp = useCallback((enabled: boolean) => {
    setAiWarmUpOnStart(enabled)
    localStorage.setItem(AI_WARMUP_KEY, String(enabled))
  }, [])

  /**
   * Builds a grounded prompt from real Git data only. Repository strings are
   * passed as data for the backend to bound and label; nothing is invented here.
   */
  const runExplain = useCallback(
    async (kind: AiRequestKind) => {
      if (!repo) return

      const useCommitData = kind === 'commit'
      const request: AiRequest | null = useCommitData
        ? buildCommitRequest(repo, selectedCommit, commitChanges, commitDiff, aiSelectedModel)
        : buildComparisonRequest(repo, comparison, mergePreview, kind, commitDiff ?? fileDiff, aiSelectedModel)

      if (!request) return
      if (aiInFlight.current) return
      aiInFlight.current = true

      // Remember which model produced this request so a mid-flight model switch
      // can be detected instead of showing one model's output under another's name.
      const modelAtRequest = aiSelectedModelRef.current

      setAiBusy(true)
      setAiState('loading')
      setAiError(null)
      setAiExplanation(null)
      setAiStatus(`Asking ${aiSelectedModel}… larger models can take a while.`)
      try {
        const result = await explainWithModel(request)
        if (aiSelectedModelRef.current !== modelAtRequest) {
          // The selection moved on; this answer no longer describes what the user
          // is looking at, so drop it rather than mislabel it.
          setAiExplanation(null)
          setAiStatus('Model changed while explaining — result discarded.')
        } else {
          setAiExplanation(result)
          setAiStatus(null)
        }
        setAiState('ready')
      } catch (err) {
        setAiState('error')
        setAiError(toGitError(err).message)
      } finally {
        // Always leaves the loading state, on every path.
        aiInFlight.current = false
        setAiBusy(false)
      }
    },
    [repo, selectedCommit, commitChanges, commitDiff, comparison, mergePreview, fileDiff, aiSelectedModel],
  )

  /** Loads a commit's real file changes for the current parent-comparison mode. */
  const loadCommitChanges = useCallback(
    async (path: string, hash: string, mode: CommitParentMode) => {
      setChangesLoading(true)
      setCommitDiffError(null)
      try {
        const result = await getCommitChanges(path, hash, mode)
        setCommitChanges(result)

        // Open the first file automatically so the pane is never empty on arrival.
        const first = result.files[0]
        if (first) {
          setSelectedCommitFile(first.path)
          setCommitDiffLoading(true)
          try {
            setCommitDiff(await getCommitDiff(path, hash, first.path, mode))
          } catch (err) {
            setCommitDiff(null)
            setCommitDiffError(toGitError(err).message)
          } finally {
            setCommitDiffLoading(false)
          }
        } else {
          setSelectedCommitFile(null)
          setCommitDiff(null)
        }
      } catch (err) {
        setCommitChanges(null)
        setCommitDiffError(toGitError(err).message)
      } finally {
        setChangesLoading(false)
      }
    },
    [],
  )

  /** Loads the unified diff for one file inside the selected commit. */
  const selectCommitFile = useCallback(
    async (hash: string, filePath: string) => {
      if (!repo) return
      setSelectedCommitFile(filePath)
      setCommitDiffLoading(true)
      setCommitDiffError(null)
      try {
        setCommitDiff(await getCommitDiff(repo.root, hash, filePath, parentMode))
      } catch (err) {
        setCommitDiff(null)
        setCommitDiffError(toGitError(err).message)
      } finally {
        setCommitDiffLoading(false)
      }
    },
    [repo, parentMode],
  )

  /** Selects a commit and loads its changes. Clears the pane when nothing is selected. */
  const selectCommit = useCallback(
    (hash: string | null) => {
      setSelectedHash(hash)
      setPanel('details')
      if (!hash || !repo) {
        setCommitChanges(null)
        setCommitDiff(null)
        setSelectedCommitFile(null)
        return
      }
      void loadCommitChanges(repo.root, hash, parentMode)
    },
    [repo, parentMode, loadCommitChanges],
  )

  const changeParentMode = useCallback(
    (mode: CommitParentMode) => {
      setParentMode(mode)
      if (repo && selectedHash) {
        void loadCommitChanges(repo.root, selectedHash, mode)
      }
    },
    [repo, selectedHash, loadCommitChanges],
  )

  const currentReport = useCallback((): string | null => {
    if (!comparison || !repo) return null
    return buildChangeReport({
      repoName: repo.name,
      comparison,
      preview: mergePreview,
      generatedAt: new Date(),
    })
  }, [comparison, repo, mergePreview])

  const exportReport = useCallback(async () => {
    const markdown = currentReport()
    if (!markdown) return

    setExporting(true)
    try {
      // The native save dialog is the only way a destination is chosen.
      const suggested = `${repo?.name ?? 'change-report'}-${comparison?.base ?? 'base'}-vs-${comparison?.compare ?? 'compare'}.md`
      const target = await saveDialog({
        title: 'Export Markdown change report',
        defaultPath: suggested.replace(/[\\/:*?"<>|]/g, '-'),
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      })
      if (!target) return

      const written = await writeTextFile(target, markdown)
      setError(null)
      setReportPreview(`${markdown}\n\n---\n\nSaved to ${written.path}`)
    } catch (err) {
      setError(toGitError(err))
    } finally {
      setExporting(false)
    }
  }, [currentReport, repo, comparison])

  const openPath = useCallback(
    async (path: string) => {
      setBusy(true)
      setError(null)
      try {
        const info = await validateRepository(path)
        setRepo(info)
        setPanel('details')
        remember(info.root)
        // Remember for next launch so the workspace reopens automatically.
        localStorage.setItem(LAST_REPO_KEY, info.root)
        // History is read from the resolved root, not the clicked subfolder.
        await loadHistory(info.root, 0, false)
        await loadBranches(info.root)
        setComparison(null)
        setMergePreview(null)
        setSelectedFile(null)
        setFileDiff(null)
        setCommitChanges(null)
        setCommitDiff(null)
        setSelectedCommitFile(null)
      } catch (err) {
        setError(toGitError(err))
      } finally {
        setBusy(false)
      }
    },
    [remember, loadHistory, loadBranches],
  )

  const pickRepository = useCallback(async () => {
    if (!inTauri) return
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Open Git repository',
      })
      if (typeof selected === 'string') {
        await openPath(selected)
      }
    } catch (err) {
      setError(toGitError(err))
    }
  }, [inTauri, openPath])

  if (!inTauri) {
    return (
      <div className="flex h-full items-center justify-center bg-canvas px-8 text-center">
        <div className="max-w-md space-y-2">
          <h1 className="text-base font-semibold">BranchMap needs the desktop shell</h1>
          <p className="text-[13px] leading-relaxed text-ink-muted">
            This window is a plain browser, so Rust commands are unavailable. Start the app with{' '}
            <code className="selectable font-mono text-ink">npm run desktop:dev</code>.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
      <TitleBar repo={repo} />

      <div className="flex min-h-0 flex-1">
        <Sidebar
          git={git}
          repo={repo}
          recentPaths={recent}
          busy={busy}
          onOpenRepository={pickRepository}
          onSelectRecent={openPath}
          onRemoveRecent={(path) =>
            setRecent((prev) => {
              const next = prev.filter((p) => p !== path)
              try {
                localStorage.setItem(RECENT_KEY, JSON.stringify(next))
              } catch {
                /* ignore */
              }
              return next
            })
          }
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <WorkspaceToolbar activePanel={panel} hasRepo={repo !== null} onSelectPanel={setPanel} />
          {repo && (
            <RepoSummaryStrip repo={repo} busy={busy} onRefresh={() => openPath(repo.root)} />
          )}

          <div className="flex min-h-0 flex-1">
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {repo ? (
                <CommitHistory
                  repo={repo}
                  commits={commits}
                  page={page}
                  loading={historyLoading}
                  loadingMore={loadingMore}
                  error={historyError}
                  selectedHash={selectedHash}
                  busy={busy}
                  onSelect={selectCommit}
                  onRefresh={() => openPath(repo.root)}
                  onRetry={() => loadHistory(repo.root, 0, false)}
                  onLoadMore={() => loadHistory(repo.root, commits.length, true)}
                />
              ) : (
                <WelcomeView onOpenRepository={pickRepository} busy={busy} />
              )}

              {/* The diff explorer opens beneath the graph so history stays
                  visible, and shows whichever view is active. */}
              {panel === 'compare' && comparison && (
                <DiffExplorer
                  files={comparison.files}
                  additions={comparison.totals.insertions}
                  deletions={comparison.totals.deletions}
                  binaryFiles={comparison.totals.binaryFiles}
                  statsAvailable
                  caption={
                    comparison.mode === 'direct'
                      ? 'tip to tip'
                      : `from merge base ${comparison.mergeBase?.slice(0, 7) ?? '—'}`
                  }
                  selectedFile={selectedFile}
                  diff={fileDiff}
                  diffLoading={diffLoading}
                  diffError={diffError}
                  onSelectFile={selectFile}
                />
              )}

              {panel === 'details' && commitChanges && (
                <DiffExplorer
                  files={commitChanges.files}
                  additions={commitChanges.totals.insertions}
                  deletions={commitChanges.totals.deletions}
                  binaryFiles={commitChanges.totals.binaryFiles}
                  statsAvailable={commitChanges.statsAvailable}
                  caption={`${commitChanges.isRoot ? 'root commit' : commitChanges.shortHash}${
                    commitChanges.isMerge
                      ? commitChanges.mode === 'combined'
                        ? ' · combined diff'
                        : ' · vs first parent'
                      : ''
                  }`}
                  selectedFile={selectedCommitFile}
                  diff={commitDiff}
                  diffLoading={commitDiffLoading}
                  diffError={commitDiffError}
                  onSelectFile={(filePath) => selectedHash && selectCommitFile(selectedHash, filePath)}
                />
              )}
            </div>

            {/* The AI panel needs more room for generated explanations. */}
            <aside
              className={`flex shrink-0 flex-col border-l border-line bg-surface ${
                panel === 'ai' ? 'w-[420px]' : 'w-80'
              }`}
            >
              {panel === 'details' && (
                <CommitDetails
                  repo={repo}
                  commit={selectedCommit}
                  changes={commitChanges}
                  changesLoading={changesLoading}
                  onParentModeChange={changeParentMode}
                />
              )}
              {panel === 'compare' && (
                <BranchCompare
                  repo={repo}
                  branches={branchList?.branches ?? []}
                  branchesLoading={branchesLoading}
                  base={baseBranch}
                  compare={compareBranch}
                  mode={diffMode}
                  comparison={comparison}
                  comparing={comparing}
                  preview={mergePreview}
                  previewing={previewing}
                  onBaseChange={setBaseBranch}
                  onCompareChange={setCompareBranch}
                  onModeChange={setDiffMode}
                  onCompare={() => {
                    if (baseBranch && compareBranch) {
                      void runComparison(repo?.root ?? '', baseBranch, compareBranch, diffMode)
                    }
                  }}
                  onPreviewMerge={runMergePreview}
                  onPreviewReport={() => {
                    const markdown = currentReport()
                    if (markdown) setReportPreview(markdown)
                  }}
                  onExportReport={exportReport}
                  exporting={exporting}
                />
              )}
              {panel === 'ai' && (
                <AiPanel
                  repo={repo}
                  comparison={comparison}
                  commit={selectedCommit}
                  commitChanges={commitChanges}
                  fileDiff={commitDiff ?? fileDiff}
                  state={aiState}
                  statusMessage={aiStatus}
                  errorMessage={aiError}
                  installed={aiInstalled}
                  running={aiRunning}
                  installHint={aiInstallHint}
                  models={aiModels}
                  selectedModel={aiSelectedModel}
                  warmUpOnStart={aiWarmUpOnStart}
                  busy={aiBusy}
                  explanation={aiExplanation}
                  onStartOllama={startAi}
                  onRetry={() => void checkAi(aiSelectedModel)}
                  onSelectModel={selectAiModel}
                  onToggleWarmUp={toggleAiWarmUp}
                  onWarmUp={warmUpAi}
                  onExplain={runExplain}
                />
              )}
            </aside>
          </div>
        </main>
      </div>

      {reportPreview !== null && (
        <ReportModal markdown={reportPreview} onClose={() => setReportPreview(null)} />
      )}

      <StatusBar
        git={git}
        repo={repo}
        error={error ? [error.message, error.hint].filter(Boolean).join(' — ') : null}
        onDismissError={() => setError(null)}
      />
    </div>
  )
}