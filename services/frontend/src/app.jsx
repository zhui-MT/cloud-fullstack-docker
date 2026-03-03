import { useEffect, useMemo, useState } from 'react'
import './app.css'
import zhCN from './i18n/zh-cn'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'
const ACCEPTED_EXTENSIONS = ['.tsv', '.txt', '.csv']
const STORAGE_KEYS = {
  sessionId: 'cloud-fullstack-docker.sessionId',
  uploadId: 'cloud-fullstack-docker.uploadId',
  runId: 'cloud-fullstack-docker.runId',
}
const LEGACY_STORAGE_KEYS = {
  sessionId: 'bioid.sessionId',
  uploadId: 'bioid.uploadId',
  runId: 'bioid.runId',
}
const STORAGE_MIGRATION_KEY = 'cloud-fullstack-docker.storage.migrated.v1'
const VIEW_ORDER = ['pca', 'correlation', 'volcano', 'enrichment']

const CONTROL_KEYWORDS = ['control', 'ctrl', 'vehicle', 'mock', 'wt', 'normal', 'untreated', 'untreat', 'blank', 'sham']
const TREATMENT_KEYWORDS = ['treat', 'treatment', 'trt', 'drug', 'case', 'disease', 'ko', 'kd', 'mut', 'stim', 'tumor', 'patient']

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function readStorage(key) {
  try {
    return localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}

function writeStorage(key, value) {
  try {
    if (value) {
      localStorage.setItem(key, value)
    } else {
      localStorage.removeItem(key)
    }
  } catch {
    // no-op: storage is best-effort only
  }
}

function migrateStorageOnce() {
  try {
    if (localStorage.getItem(STORAGE_MIGRATION_KEY) === '1') {
      return
    }

    for (const [name, nextKey] of Object.entries(STORAGE_KEYS)) {
      const legacyKey = LEGACY_STORAGE_KEYS[name]
      if (!legacyKey) {
        continue
      }
      const currentValue = localStorage.getItem(nextKey)
      if (currentValue && String(currentValue).trim() !== '') {
        continue
      }
      const legacyValue = localStorage.getItem(legacyKey)
      if (legacyValue && String(legacyValue).trim() !== '') {
        localStorage.setItem(nextKey, legacyValue)
      }
    }

    for (const key of Object.values(LEGACY_STORAGE_KEYS)) {
      localStorage.removeItem(key)
    }
    localStorage.setItem(STORAGE_MIGRATION_KEY, '1')
  } catch {
    // no-op: storage is best-effort only
  }
}

function formatTime(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString('zh-CN')
}

function shortenId(value) {
  if (!value || value.length <= 24) {
    return value || '-'
  }
  return `${value.slice(0, 10)}...${value.slice(-8)}`
}

function sanitizeName(value) {
  return String(value || '').trim().toLowerCase()
}

function includesKeyword(name, keywords) {
  const normalized = sanitizeName(name)
  return keywords.some((keyword) => normalized.includes(keyword))
}

function inferGroupFromSampleName(sampleName) {
  if (includesKeyword(sampleName, CONTROL_KEYWORDS)) {
    return 'Control'
  }
  if (includesKeyword(sampleName, TREATMENT_KEYWORDS)) {
    return 'Treatment'
  }
  return 'Unassigned'
}

function buildInitialGrouping(sampleColumns = []) {
  return Object.fromEntries(sampleColumns.map((sample) => [sample, inferGroupFromSampleName(sample)]))
}

function hasSupportedExtension(fileName = '') {
  const lower = fileName.toLowerCase()
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

async function parseResponseJson(response) {
  const text = await response.text()
  if (!text) {
    return null
  }
  try {
    return JSON.parse(text)
  } catch {
    return { message: text }
  }
}

async function requestJson(path, init = {}) {
  const response = await fetch(apiUrl(path), init)
  const payload = await parseResponseJson(response)

  if (!response.ok) {
    const details = []
    if (payload?.error) {
      details.push(String(payload.error))
    }
    if (Array.isArray(payload?.details) && payload.details.length > 0) {
      details.push(payload.details.map((item) => String(item)).join('; '))
    } else if (payload?.details) {
      details.push(String(payload.details))
    }
    if (payload?.message && payload.message !== payload?.error) {
      details.push(String(payload.message))
    }
    if (details.length === 0) {
      details.push(`HTTP ${response.status}`)
    }
    throw new Error(details.join(' | '))
  }

  return payload
}

function buildClientError(prefix, error) {
  const detail = error instanceof Error ? error.message : String(error)
  return `${prefix}\nEN detail: ${detail}`
}

function isTerminalRunStatus(status) {
  return status === 'succeeded' || status === 'failed' || status === 'canceled'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function buildActiveSampleGroups(sampleColumns = [], sampleGroups = {}) {
  return Object.fromEntries(sampleColumns.map((sample) => [sample, sampleGroups[sample] || inferGroupFromSampleName(sample)]))
}

function summarizeViewData(viewKey, data = {}) {
  if (viewKey === 'pca') {
    return `${zhCN.results.summaryLabel}: points=${Array.isArray(data.points) ? data.points.length : 0}`
  }
  if (viewKey === 'correlation') {
    return `${zhCN.results.summaryLabel}: samples=${Array.isArray(data.labels) ? data.labels.length : 0}`
  }
  if (viewKey === 'volcano') {
    return `${zhCN.results.summaryLabel}: points=${Array.isArray(data.points) ? data.points.length : 0}`
  }
  if (viewKey === 'enrichment') {
    return `${zhCN.results.summaryLabel}: terms=${Array.isArray(data.entries) ? data.entries.length : 0}`
  }
  return `${zhCN.results.summaryLabel}: -`
}

function triggerBlobDownload(blob, fileName) {
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(href)
}

function runErrorDetail(run) {
  const error = run?.error
  if (!error) {
    return 'analysis run failed'
  }
  if (typeof error === 'string') {
    return error
  }
  if (typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message
  }
  return JSON.stringify(error)
}

function uploadSummaryRows(upload) {
  const summary = upload?.summary || {}
  const detected = upload?.detected || {}
  return [
    [zhCN.fields.sourceTool, detected.sourceTool || '-'],
    [zhCN.fields.entityType, detected.entityType || '-'],
    [zhCN.fields.delimiter, detected.delimiter || '-'],
    [zhCN.fields.rowCount, summary.rowCount ?? '-'],
    [zhCN.fields.sampleCount, summary.sampleCount ?? '-'],
    [zhCN.fields.entityCount, summary.entityCount ?? '-'],
  ]
}

function renderPreviewValue(value) {
  if (value === null || value === undefined || value === '') {
    return '-'
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

function UploadEcho({ upload }) {
  if (!upload) {
    return <p className="muted">-</p>
  }

  const sampleColumns = upload.summary?.sampleColumns || []
  const warnings = upload.summary?.warnings || []
  const availableColumns = upload.summary?.availableColumns || []

  return (
    <div className="upload-echo">
      <div className="summary-grid">
        {uploadSummaryRows(upload).map(([label, value]) => (
          <div key={label} className="summary-item">
            <span className="summary-label">{label}</span>
            <strong className="summary-value">{value}</strong>
          </div>
        ))}
      </div>

      <div className="list-block">
        <span className="list-label">{zhCN.fields.sampleColumns}</span>
        <p className="list-value">{sampleColumns.length > 0 ? sampleColumns.join(', ') : '-'}</p>
      </div>

      <div className="list-block">
        <span className="list-label">{zhCN.fields.availableColumns}</span>
        <p className="list-value">{availableColumns.length > 0 ? availableColumns.join(', ') : '-'}</p>
      </div>

      <div className="list-block">
        <span className="list-label">{zhCN.fields.warnings}</span>
        {warnings.length > 0 ? (
          <ul className="warning-list">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        ) : (
          <p className="list-value">-</p>
        )}
      </div>

      <div className="list-block">
        <span className="list-label">preview</span>
        {Array.isArray(upload.preview) && upload.preview.length > 0 ? (
          <div className="preview-table-wrap">
            <table className="preview-table">
              <thead>
                <tr>
                  <th>entityType</th>
                  <th>accession</th>
                  <th>sequence</th>
                  <th>modifiedSequence</th>
                  <th>gene</th>
                  <th>proteinGroup</th>
                  <th>quantities</th>
                </tr>
              </thead>
              <tbody>
                {upload.preview.map((row, index) => (
                  <tr key={`${row.accession || row.sequence || 'row'}-${index}`}>
                    <td>{renderPreviewValue(row.entityType)}</td>
                    <td>{renderPreviewValue(row.accession)}</td>
                    <td>{renderPreviewValue(row.sequence)}</td>
                    <td>{renderPreviewValue(row.modifiedSequence)}</td>
                    <td>{renderPreviewValue(row.gene)}</td>
                    <td>{renderPreviewValue(row.proteinGroup)}</td>
                    <td>{renderPreviewValue(row.quantities)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="list-value">-</p>
        )}
      </div>
    </div>
  )
}

function AnalysisResultCards({ run, onDownloadPng, pngDownloadingByView }) {
  const views = run?.result?.views || {}
  const hasAnyView = VIEW_ORDER.some((key) => Boolean(views[key]))

  if (!hasAnyView) {
    return <p className="placeholder">{zhCN.results.noRunYet}</p>
  }

  return (
    <div className="result-card-grid">
      {VIEW_ORDER.map((viewKey) => {
        const view = views[viewKey]
        if (!view) {
          return (
            <article key={viewKey} className="result-card">
              <h4>{zhCN.results.viewTitles[viewKey] || viewKey}</h4>
              <p className="placeholder">-</p>
            </article>
          )
        }
        const downloads = view.downloads || {}
        return (
          <article key={viewKey} className="result-card">
            <h4>{zhCN.results.viewTitles[viewKey] || viewKey}</h4>
            <p className="muted">{summarizeViewData(viewKey, view.data || {})}</p>
            <div className="download-row">
              <a className="download-link" href={apiUrl(downloads.csv || '#')} target="_blank" rel="noreferrer">
                {zhCN.results.downloads.csv}
              </a>
              <a className="download-link" href={apiUrl(downloads.svg || '#')} target="_blank" rel="noreferrer">
                {zhCN.results.downloads.svg}
              </a>
              <button
                type="button"
                className="ghost"
                onClick={() => onDownloadPng(viewKey, downloads.png)}
                disabled={!downloads.png || Boolean(pngDownloadingByView[viewKey])}
              >
                {pngDownloadingByView[viewKey] ? zhCN.results.downloads.pngBusy : zhCN.results.downloads.png}
              </button>
              <a className="download-link" href={apiUrl(downloads.meta || '#')} target="_blank" rel="noreferrer">
                {zhCN.results.downloads.meta}
              </a>
            </div>
          </article>
        )
      })}
    </div>
  )
}

function App() {
  const [filePickerKey, setFilePickerKey] = useState(0)
  const [selectedFile, setSelectedFile] = useState(null)
  const [sessionId, setSessionId] = useState('')
  const [uploadId, setUploadId] = useState('')
  const [currentUpload, setCurrentUpload] = useState(null)
  const [recentUploads, setRecentUploads] = useState([])
  const [sampleGroups, setSampleGroups] = useState({})
  const [groupEdited, setGroupEdited] = useState(false)
  const [configRev, setConfigRev] = useState('rev-0005')
  const [engine, setEngine] = useState('limma')
  const [species, setSpecies] = useState('human')
  const [bootLoading, setBootLoading] = useState(true)
  const [creatingSession, setCreatingSession] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [runSubmitting, setRunSubmitting] = useState(false)
  const [runPolling, setRunPolling] = useState(false)
  const [analysisRun, setAnalysisRun] = useState(null)
  const [pngDownloadingByView, setPngDownloadingByView] = useState({})
  const [statusMessage, setStatusMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const sampleColumns = useMemo(() => currentUpload?.summary?.sampleColumns || [], [currentUpload])

  const groupStats = useMemo(() => {
    const stats = {
      Control: 0,
      Treatment: 0,
      Unassigned: 0,
    }

    for (const sample of sampleColumns) {
      const group = sampleGroups[sample] || 'Unassigned'
      if (!stats[group]) {
        stats.Unassigned += 1
      } else {
        stats[group] += 1
      }
    }

    return stats
  }, [sampleColumns, sampleGroups])

  const groupReady = groupStats.Control > 0 && groupStats.Treatment > 0

  async function loadSessionUploads(targetSessionId, options = {}) {
    if (!targetSessionId) {
      setRecentUploads([])
      return []
    }

    try {
      const list = await requestJson(`/api/session/${encodeURIComponent(targetSessionId)}/uploads?limit=8&offset=0`)
      const uploads = Array.isArray(list.uploads) ? list.uploads : []
      setRecentUploads(uploads)
      return uploads
    } catch (error) {
      if (!options.silent) {
        setErrorMessage(buildClientError(zhCN.errors.loadUploadListFailed, error))
      }
      return []
    }
  }

  async function loadUploadDetail(targetUploadId, options = {}) {
    if (!targetUploadId) {
      return null
    }

    try {
      const detail = await requestJson(`/api/upload/${encodeURIComponent(String(targetUploadId))}`)
      setCurrentUpload(detail)
      if (detail.sessionId) {
        setSessionId(detail.sessionId)
        writeStorage(STORAGE_KEYS.sessionId, detail.sessionId)
      }
      setUploadId(String(detail.uploadId))
      writeStorage(STORAGE_KEYS.uploadId, String(detail.uploadId))
      const inferred = buildInitialGrouping(detail.summary?.sampleColumns || [])
      setSampleGroups(inferred)
      setGroupEdited(false)
      return detail
    } catch (error) {
      if (!options.silent) {
        setErrorMessage(buildClientError(zhCN.errors.loadUploadFailed, error))
      }
      return null
    }
  }

  function clearAnalysisRunState() {
    setAnalysisRun(null)
    setPngDownloadingByView({})
    writeStorage(STORAGE_KEYS.runId, '')
  }

  async function loadAnalysisRun(runId, options = {}) {
    const normalized = String(runId || '').trim()
    if (!normalized) {
      return null
    }

    try {
      const run = await requestJson(`/api/analysis/run/${encodeURIComponent(normalized)}`)
      setAnalysisRun(run)
      writeStorage(STORAGE_KEYS.runId, String(run.runId))
      return run
    } catch (error) {
      if (!options.silent) {
        setErrorMessage(buildClientError(zhCN.errors.runPollFailed, error))
      }
      return null
    }
  }

  async function waitForRunTerminal(runId, options = {}) {
    const maxAttempts = options.maxAttempts || 120
    const intervalMs = options.intervalMs || 1500
    setRunPolling(true)
    try {
      let latest = null
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        latest = await loadAnalysisRun(runId, { silent: true })
        if (!latest) {
          throw new Error('run not found')
        }
        if (isTerminalRunStatus(latest.status)) {
          return latest
        }
        await sleep(intervalMs)
      }
      throw new Error(zhCN.errors.runTimeoutDetail)
    } finally {
      setRunPolling(false)
    }
  }

  async function createSession(options = {}) {
    const { silent = false } = options

    if (sessionId) {
      if (!silent) {
        setStatusMessage(zhCN.status.sessionReady)
      }
      return sessionId
    }

    setCreatingSession(true)
    try {
      const body = await requestJson('/api/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `bioid-web-${new Date().toISOString()}` }),
      })

      setSessionId(body.sessionId)
      writeStorage(STORAGE_KEYS.sessionId, body.sessionId)
      if (!silent) {
        setStatusMessage(`${zhCN.status.sessionCreated}: ${shortenId(body.sessionId)}`)
      }
      return body.sessionId
    } catch (error) {
      if (!silent) {
        setErrorMessage(buildClientError(zhCN.errors.createSessionFailed, error))
      }
      return ''
    } finally {
      setCreatingSession(false)
    }
  }

  async function downloadPngFromPayload(viewKey, pngPath) {
    if (!pngPath) {
      return
    }
    setPngDownloadingByView((prev) => ({ ...prev, [viewKey]: true }))
    try {
      const payload = await requestJson(pngPath)
      const svgText = typeof payload?.svg === 'string' ? payload.svg : ''
      if (!svgText) {
        throw new Error('png payload missing svg')
      }

      const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' })
      const svgUrl = URL.createObjectURL(svgBlob)
      try {
        const image = await new Promise((resolve, reject) => {
          const img = new Image()
          img.onload = () => resolve(img)
          img.onerror = () => reject(new Error('failed to render svg into image'))
          img.src = svgUrl
        })

        const width = Math.max(1, Number(image.naturalWidth) || 1600)
        const height = Math.max(1, Number(image.naturalHeight) || 1000)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        if (!context) {
          throw new Error('canvas context unavailable')
        }
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)

        const pngBlob = await new Promise((resolve) => {
          canvas.toBlob((blob) => resolve(blob), 'image/png')
        })
        if (!pngBlob) {
          throw new Error('failed to export png blob')
        }

        const runLabel = analysisRun?.runId ? `run-${analysisRun.runId}` : 'analysis'
        triggerBlobDownload(pngBlob, `${viewKey}-${runLabel}.png`)
      } finally {
        URL.revokeObjectURL(svgUrl)
      }
    } catch (error) {
      setErrorMessage(buildClientError(zhCN.errors.runPngFailed, error))
    } finally {
      setPngDownloadingByView((prev) => ({ ...prev, [viewKey]: false }))
    }
  }

  useEffect(() => {
    async function bootstrap() {
      migrateStorageOnce()
      const storedSessionId = readStorage(STORAGE_KEYS.sessionId)
      const storedUploadId = readStorage(STORAGE_KEYS.uploadId)
      const storedRunId = readStorage(STORAGE_KEYS.runId)

      if (!storedSessionId) {
        setBootLoading(false)
        return
      }

      setSessionId(storedSessionId)
      setStatusMessage(`${zhCN.status.sessionReady}: ${shortenId(storedSessionId)}`)
      await loadSessionUploads(storedSessionId, { silent: true })

      if (storedUploadId) {
        const detail = await loadUploadDetail(storedUploadId, { silent: true })
        if (!detail) {
          writeStorage(STORAGE_KEYS.uploadId, '')
        }
      }

      if (storedRunId) {
        const run = await loadAnalysisRun(storedRunId, { silent: true })
        if (!run) {
          writeStorage(STORAGE_KEYS.runId, '')
        } else if (!isTerminalRunStatus(run.status)) {
          setStatusMessage(`${zhCN.status.runResumePolling}: ${run.runId}`)
          try {
            const terminal = await waitForRunTerminal(run.runId, { maxAttempts: 80, intervalMs: 1000 })
            if (terminal.status === 'succeeded') {
              setStatusMessage(`${zhCN.status.runSucceeded}: runId=${terminal.runId}`)
            } else if (terminal.status === 'failed') {
              setErrorMessage(`${zhCN.errors.runFailed}\nEN detail: ${runErrorDetail(terminal)}`)
            }
          } catch (error) {
            setErrorMessage(buildClientError(zhCN.errors.runPollFailed, error))
          }
        }
      }

      setBootLoading(false)
    }

    bootstrap()
  }, [])

  async function handleCreateSession() {
    setErrorMessage('')
    const created = await createSession()
    if (created) {
      await loadSessionUploads(created, { silent: true })
    }
  }

  async function handleRunAnalysis() {
    setErrorMessage('')
    setStatusMessage('')

    if (!sessionId) {
      setErrorMessage(zhCN.errors.runSessionRequired)
      return
    }
    if (!uploadId) {
      setErrorMessage(zhCN.errors.runUploadRequired)
      return
    }
    if (!groupReady) {
      setErrorMessage(zhCN.errors.runPrecheck)
      return
    }

    const activeSampleGroups = buildActiveSampleGroups(sampleColumns, sampleGroups)
    const runPayload = {
      sessionId,
      uploadId: Number(uploadId),
      engine,
      config_tag: configRev || undefined,
      de: {
        groupA: 'Control',
        groupB: 'Treatment',
        log2fcThreshold: 1,
        padjThreshold: 0.05,
      },
      enrichment: {
        species,
        pvalueCutoff: 0.05,
        qvalueCutoff: 0.2,
      },
      sampleGroups: activeSampleGroups,
    }

    setRunSubmitting(true)
    try {
      const created = await requestJson('/api/analysis/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(runPayload),
      })

      const runSnapshot = {
        runId: created.runId,
        status: created.status,
        binding: created.binding,
        result: null,
        error: null,
        runtime: null,
      }
      setAnalysisRun(runSnapshot)
      writeStorage(STORAGE_KEYS.runId, String(created.runId))
      setStatusMessage(`${zhCN.status.runStarted}: runId=${created.runId}`)

      const terminal = await waitForRunTerminal(created.runId)
      if (terminal.status === 'succeeded') {
        setStatusMessage(`${zhCN.status.runSucceeded}: runId=${terminal.runId}`)
      } else if (terminal.status === 'failed') {
        setErrorMessage(`${zhCN.errors.runFailed}\nEN detail: ${runErrorDetail(terminal)}`)
      }
    } catch (error) {
      setErrorMessage(buildClientError(zhCN.errors.runCreateFailed, error))
    } finally {
      setRunSubmitting(false)
    }
  }

  async function handleUpload(event) {
    event.preventDefault()
    setErrorMessage('')
    setStatusMessage('')

    if (!selectedFile) {
      setErrorMessage(zhCN.errors.fileRequired)
      return
    }

    if (!hasSupportedExtension(selectedFile.name)) {
      setErrorMessage(zhCN.errors.fileTypeInvalid)
      return
    }

    const activeSessionId = sessionId || (await createSession({ silent: true }))
    if (!activeSessionId) {
      setErrorMessage(zhCN.errors.createSessionFailed)
      return
    }

    setUploading(true)
    try {
      const formData = new FormData()
      formData.append('sessionId', activeSessionId)
      formData.append('file', selectedFile)

      const upload = await requestJson('/api/upload', {
        method: 'POST',
        body: formData,
      })

      setCurrentUpload(upload)
      setUploadId(String(upload.uploadId))
      writeStorage(STORAGE_KEYS.uploadId, String(upload.uploadId))
      clearAnalysisRunState()
      setStatusMessage(`${zhCN.status.uploadDone}: uploadId=${upload.uploadId}`)
      const inferred = buildInitialGrouping(upload.summary?.sampleColumns || [])
      setSampleGroups(inferred)
      setGroupEdited(false)
      setSelectedFile(null)
      setFilePickerKey((value) => value + 1)
      await loadSessionUploads(activeSessionId, { silent: true })
    } catch (error) {
      setErrorMessage(buildClientError(zhCN.errors.uploadFailed, error))
    } finally {
      setUploading(false)
    }
  }

  function handleSelectFile(event) {
    const file = event.target.files && event.target.files[0]
    setSelectedFile(file || null)
  }

  function handleChangeGroup(sample, value) {
    setSampleGroups((prev) => ({ ...prev, [sample]: value }))
    setGroupEdited(true)
  }

  function handleClearUpload() {
    setCurrentUpload(null)
    setUploadId('')
    setSampleGroups({})
    setGroupEdited(false)
    clearAnalysisRunState()
    writeStorage(STORAGE_KEYS.uploadId, '')
    setStatusMessage(zhCN.status.uploadCleared)
    setErrorMessage('')
  }

  async function handlePickRecentUpload(nextUploadId) {
    setErrorMessage('')
    clearAnalysisRunState()
    await loadUploadDetail(nextUploadId)
  }

  const uploadButtonLabel = uploading
    ? zhCN.upload.uploading
    : sessionId
      ? zhCN.upload.uploadAgain
      : zhCN.upload.createSessionAndUpload
  const runButtonLabel = runSubmitting
    ? zhCN.results.runStarting
    : runPolling
      ? zhCN.results.runPolling
      : zhCN.results.runButton
  const runStatus = analysisRun?.status || '-'
  const runIdText = analysisRun?.runId ? String(analysisRun.runId) : '-'

  return (
    <main className="container">
      <header className="hero">
        <h1>{zhCN.appTitle}</h1>
        <p>{zhCN.appSubtitle}</p>
      </header>

      {bootLoading ? <p className="muted">加载本地 session 状态...</p> : null}
      {statusMessage ? <p className="status">{statusMessage}</p> : null}
      {errorMessage ? <p className="error">{errorMessage}</p> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>{zhCN.sections.upload}</h2>
          <p>{zhCN.upload.description}</p>
        </div>

        <div className="session-row">
          <div className="session-chip">
            <span>{zhCN.fields.sessionId}</span>
            <strong title={sessionId || '-'}>{shortenId(sessionId)}</strong>
          </div>
          <div className="session-chip">
            <span>{zhCN.fields.uploadId}</span>
            <strong title={uploadId || '-'}>{uploadId || '-'}</strong>
          </div>
          <button type="button" onClick={handleCreateSession} disabled={creatingSession || uploading || runSubmitting || runPolling}>
            {creatingSession ? '创建中...' : zhCN.upload.createSession}
          </button>
          <button
            type="button"
            className="ghost"
            onClick={handleClearUpload}
            disabled={!currentUpload || uploading || runSubmitting || runPolling}
          >
            {zhCN.upload.clearCurrentUpload}
          </button>
        </div>

        <form className="upload-form" onSubmit={handleUpload}>
          <label htmlFor="upload-file" className="file-field">
            <span>{zhCN.upload.chooseFile}</span>
            <input
              key={filePickerKey}
              id="upload-file"
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(',')}
              onChange={handleSelectFile}
            />
          </label>
          <div className="file-meta">
            <span>{zhCN.upload.selectedFile}：</span>
            <strong>{selectedFile ? selectedFile.name : '-'}</strong>
          </div>
          <p className="muted">{zhCN.upload.accepted}</p>
          <button type="submit" disabled={uploading || creatingSession || runSubmitting || runPolling}>
            {uploadButtonLabel}
          </button>
        </form>

        <div className="content-block">
          <h3>{zhCN.upload.parserEcho}</h3>
          <UploadEcho upload={currentUpload} />
        </div>

        <div className="content-block">
          <h3>{zhCN.upload.latestUploads}</h3>
          {recentUploads.length === 0 ? (
            <p className="muted">-</p>
          ) : (
            <div className="recent-list">
              {recentUploads.map((item) => (
                <button
                  type="button"
                  className="recent-item"
                  key={item.uploadId}
                  onClick={() => handlePickRecentUpload(item.uploadId)}
                >
                  <strong>#{item.uploadId}</strong>
                  <span>{item.fileName}</span>
                  <span>
                    {item.detected?.sourceTool}/{item.detected?.entityType}
                  </span>
                  <span>{formatTime(item.createdAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{zhCN.sections.settings}</h2>
          <p>{zhCN.settings.description}</p>
        </div>

        <div className="settings-grid">
          <label>
            <span>{zhCN.settings.configRev}</span>
            <input value={configRev} onChange={(event) => setConfigRev(event.target.value)} placeholder="rev-0005" />
          </label>
          <label>
            <span>{zhCN.settings.engine}</span>
            <select value={engine} onChange={(event) => setEngine(event.target.value)}>
              <option value="limma">limma</option>
            </select>
          </label>
          <label>
            <span>{zhCN.settings.species}</span>
            <select value={species} onChange={(event) => setSpecies(event.target.value)}>
              <option value="human">human</option>
            </select>
          </label>
        </div>

        <div className="content-block">
          <h3>{zhCN.settings.sampleGrouping}</h3>
          <p className="muted">{zhCN.settings.autoRule}</p>
          {sampleColumns.length === 0 ? (
            <p className="muted">请先上传并解析文件。</p>
          ) : (
            <>
              <table className="group-table">
                <thead>
                  <tr>
                    <th>sample</th>
                    <th>{zhCN.settings.groupLabel}</th>
                    <th>inferred</th>
                  </tr>
                </thead>
                <tbody>
                  {sampleColumns.map((sample) => {
                    const inferred = inferGroupFromSampleName(sample)
                    const group = sampleGroups[sample] || 'Unassigned'
                    return (
                      <tr key={sample}>
                        <td>{sample}</td>
                        <td>
                          <select value={group} onChange={(event) => handleChangeGroup(sample, event.target.value)}>
                            <option value="Control">Control</option>
                            <option value="Treatment">Treatment</option>
                            <option value="Unassigned">{zhCN.settings.unresolved}</option>
                          </select>
                        </td>
                        <td>{inferred}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>

              <div className="summary-grid">
                <div className="summary-item">
                  <span className="summary-label">{zhCN.settings.controlCount}</span>
                  <strong className="summary-value">{groupStats.Control}</strong>
                </div>
                <div className="summary-item">
                  <span className="summary-label">{zhCN.settings.treatmentCount}</span>
                  <strong className="summary-value">{groupStats.Treatment}</strong>
                </div>
                <div className="summary-item">
                  <span className="summary-label">{zhCN.settings.unassignedCount}</span>
                  <strong className="summary-value">{groupStats.Unassigned}</strong>
                </div>
                <div className="summary-item">
                  <span className="summary-label">manual override</span>
                  <strong className="summary-value">{groupEdited ? 'yes' : 'no'}</strong>
                </div>
              </div>
            </>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{zhCN.sections.results}</h2>
          <p>{zhCN.results.description}</p>
        </div>

        <div className="content-block">
          <h3>{zhCN.results.readyTitle}</h3>
          <ul className="ready-list">
            <li>
              {zhCN.fields.sessionId}: <strong>{sessionId || '-'}</strong>
            </li>
            <li>
              {zhCN.fields.uploadId}: <strong>{uploadId || '-'}</strong>
            </li>
            <li>
              {zhCN.settings.configRev}: <strong>{configRev || '-'}</strong>
            </li>
            <li>
              {zhCN.settings.engine}: <strong>{engine}</strong>
            </li>
            <li>
              groupReady:{' '}
              <strong>{groupReady ? 'true' : 'false'}</strong>
            </li>
            <li>
              {zhCN.results.runId}: <strong>{runIdText}</strong>
            </li>
            <li>
              {zhCN.results.runStatus}: <strong>{runStatus}</strong>
            </li>
          </ul>
          <div className="run-actions">
            <button
              type="button"
              onClick={handleRunAnalysis}
              disabled={!sessionId || !uploadId || !groupReady || runSubmitting || runPolling}
            >
              {runButtonLabel}
            </button>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                clearAnalysisRunState()
                setStatusMessage(zhCN.status.runCleared)
              }}
              disabled={!analysisRun || runSubmitting || runPolling}
            >
              {zhCN.results.clearRun}
            </button>
          </div>
          {!groupReady ? <p className="muted">{zhCN.results.groupHint}</p> : null}
          <p className="placeholder">{zhCN.results.placeholder}</p>
        </div>

        <div className="content-block">
          <h3>{zhCN.results.cardsTitle}</h3>
          <AnalysisResultCards
            run={analysisRun}
            onDownloadPng={downloadPngFromPayload}
            pngDownloadingByView={pngDownloadingByView}
          />
        </div>
      </section>
    </main>
  )
}

export default App
