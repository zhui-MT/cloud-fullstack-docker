import { useEffect, useMemo, useState } from 'react'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000'

const chartColors = {
  Control: '#0b5fa5',
  'Treat-A': '#e85d04',
  'Treat-B': '#52b788',
}

function apiUrl(path) {
  return `${API_BASE}${path}`
}

function downloadBlob(name, blob) {
  const a = document.createElement('a')
  const url = URL.createObjectURL(blob)
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}

async function downloadPngFromPayload(downloadPath, fallbackName) {
  const payload = await fetch(apiUrl(downloadPath)).then((r) => r.json())
  const svgBlob = new Blob([payload.svg], { type: 'image/svg+xml;charset=utf-8' })
  const svgUrl = URL.createObjectURL(svgBlob)

  const img = new Image()
  img.src = svgUrl
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = reject
  })

  const canvas = document.createElement('canvas')
  canvas.width = img.width || 980
  canvas.height = img.height || 560
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, 0, 0)

  const metadata = payload.artifact
  const name = metadata?.file_name || `${fallbackName}.png`
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  downloadBlob(name, blob)
  URL.revokeObjectURL(svgUrl)
}

function PcaChart({ data, selectedGroup, setSelectedGroup }) {
  const points = selectedGroup === 'All' ? data.points : data.points.filter((p) => p.group === selectedGroup)
  const xMin = -5
  const xMax = 5
  const yMin = -5
  const yMax = 5

  const x = (v) => 40 + ((v - xMin) / (xMax - xMin)) * 520
  const y = (v) => 300 - ((v - yMin) / (yMax - yMin)) * 260

  return (
    <>
      <div className="toolbar">
        <label>
          Group
          <select value={selectedGroup} onChange={(e) => setSelectedGroup(e.target.value)}>
            <option>All</option>
            <option>Control</option>
            <option>Treat-A</option>
            <option>Treat-B</option>
          </select>
        </label>
      </div>
      <svg viewBox="0 0 620 340" className="chart">
        <rect x="0" y="0" width="620" height="340" fill="#f8fafc" />
        <line x1="40" y1="170" x2="560" y2="170" stroke="#94a3b8" strokeDasharray="4 4" />
        <line x1="300" y1="40" x2="300" y2="300" stroke="#94a3b8" strokeDasharray="4 4" />
        {points.map((p) => (
          <circle key={p.sample_id} cx={x(p.pc1)} cy={y(p.pc2)} r="5" fill={chartColors[p.group]} opacity="0.85">
            <title>{`${p.sample_id} ${p.group} PC1=${p.pc1} PC2=${p.pc2}`}</title>
          </circle>
        ))}
      </svg>
    </>
  )
}

function CorrelationChart({ data }) {
  const size = data.labels.length
  const cell = 24
  const colorFor = (value) => {
    const t = Math.max(0, Math.min(1, (value + 1) / 2))
    const r = Math.round(245 - t * 180)
    const g = Math.round(248 - t * 120)
    const b = Math.round(252 - t * 220)
    return `rgb(${r},${g},${b})`
  }

  return (
    <svg viewBox={`0 0 ${size * cell + 220} ${size * cell + 120}`} className="chart">
      <rect width="100%" height="100%" fill="#ffffff" />
      {data.labels.map((label, i) => (
        <text key={`row-${label}`} x="94" y={68 + i * cell} textAnchor="end" className="axis-label">
          {label}
        </text>
      ))}
      {data.labels.map((label, i) => (
        <text key={`col-${label}`} x={118 + i * cell} y="36" transform={`rotate(-45 118 ${36 + i * 0})`} className="axis-label">
          {label}
        </text>
      ))}
      {data.matrix.map((row, i) =>
        row.map((value, j) => (
          <rect key={`${i}-${j}`} x={110 + j * cell} y={54 + i * cell} width={cell} height={cell} fill={colorFor(value)} stroke="#d1d5db">
            <title>{`${data.labels[i]} vs ${data.labels[j]}: ${value}`}</title>
          </rect>
        ))
      )}
    </svg>
  )
}

function VolcanoChart({ data }) {
  const [threshold, setThreshold] = useState(1)
  const filtered = useMemo(
    () => data.points.filter((p) => Math.abs(p.log2fc) >= threshold || p.p_adj < data.threshold.p_adj),
    [data.points, data.threshold.p_adj, threshold]
  )

  const x = (v) => 30 + ((v + 4) / 8) * 560
  const y = (v) => 300 - (Math.min(v, 6) / 6) * 260
  const color = (c) => (c === 'up' ? '#d00000' : c === 'down' ? '#0077b6' : '#9ca3af')

  return (
    <>
      <div className="toolbar">
        <label>
          |log2FC| filter: {threshold.toFixed(1)}
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </label>
      </div>
      <svg viewBox="0 0 620 340" className="chart">
        <rect x="0" y="0" width="620" height="340" fill="#f8fafc" />
        <line x1="310" y1="40" x2="310" y2="300" stroke="#94a3b8" strokeDasharray="4 4" />
        <line x1="30" y1={y(-Math.log10(data.threshold.p_adj))} x2="590" y2={y(-Math.log10(data.threshold.p_adj))} stroke="#94a3b8" strokeDasharray="4 4" />
        {filtered.map((p) => (
          <circle key={p.id} cx={x(p.log2fc)} cy={y(p.neg_log10_p_adj)} r="2.5" fill={color(p.category)} opacity="0.75">
            <title>{`${p.id} log2FC=${p.log2fc} padj=${p.p_adj}`}</title>
          </circle>
        ))}
      </svg>
    </>
  )
}

function EnrichmentChart({ data }) {
  const [topN, setTopN] = useState(8)
  const items = data.entries.slice(0, topN)
  const maxNes = Math.max(...items.map((i) => i.nes))

  return (
    <>
      <div className="toolbar">
        <label>
          Top N
          <select value={topN} onChange={(e) => setTopN(Number(e.target.value))}>
            <option value={5}>5</option>
            <option value={8}>8</option>
            <option value={12}>12</option>
          </select>
        </label>
      </div>
      <svg viewBox="0 0 760 380" className="chart">
        <rect width="100%" height="100%" fill="#ffffff" />
        {items.map((item, i) => {
          const y = 30 + i * 28
          const width = (item.nes / maxNes) * 360
          return (
            <g key={item.term}>
              <text x="220" y={y + 16} textAnchor="end" className="axis-label">
                {item.term}
              </text>
              <rect x="230" y={y} width={width} height="20" rx="3" fill={item.p_adj < 0.01 ? '#0466c8' : '#48bfe3'}>
                <title>{`${item.term} NES=${item.nes} padj=${item.p_adj}`}</title>
              </rect>
              <text x={238 + width} y={y + 15} className="axis-label">
                {item.nes}
              </text>
            </g>
          )
        })}
      </svg>
    </>
  )
}

function DownloadButtons({ viewName, downloads }) {
  return (
    <div className="downloads">
      <a href={apiUrl(downloads.svg)} target="_blank" rel="noreferrer">
        Download SVG
      </a>
      <a href={apiUrl(downloads.csv)} target="_blank" rel="noreferrer">
        Download CSV
      </a>
      <button onClick={() => downloadPngFromPayload(downloads.png, viewName)}>Download PNG</button>
    </div>
  )
}

function App() {
  const [configRev, setConfigRev] = useState('rev-0005')
  const [analysis, setAnalysis] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedGroup, setSelectedGroup] = useState('All')

  async function loadAnalysis() {
    setLoading(true)
    setError('')
    try {
      const data = await fetch(apiUrl(`/api/analysis?config_rev=${encodeURIComponent(configRev)}`)).then((r) => r.json())
      setAnalysis(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadAnalysis()
  }, [])

  return (
    <main className="container">
      <header>
        <h1>BioID Proteomics Analyst · Round 5</h1>
        <p>Interactive analytics + reproducible artifacts (`config_rev`).</p>
      </header>

      <section className="config-panel">
        <label>
          config_rev
          <input value={configRev} onChange={(e) => setConfigRev(e.target.value)} placeholder="rev-0005" />
        </label>
        <button onClick={loadAnalysis} disabled={loading}>
          {loading ? 'Loading...' : 'Run Analysis'}
        </button>
        {analysis ? <span className="meta">generated_at: {analysis.generated_at}</span> : null}
      </section>

      {error ? <p className="error">{error}</p> : null}

      {analysis ? (
        <section className="grid">
          <article className="card">
            <h2>PCA</h2>
            <DownloadButtons viewName="pca" downloads={analysis.views.pca.downloads} />
            <PcaChart data={analysis.views.pca.data} selectedGroup={selectedGroup} setSelectedGroup={setSelectedGroup} />
          </article>

          <article className="card">
            <h2>Correlation Heatmap</h2>
            <DownloadButtons viewName="correlation" downloads={analysis.views.correlation.downloads} />
            <CorrelationChart data={analysis.views.correlation.data} />
          </article>

          <article className="card">
            <h2>Volcano</h2>
            <DownloadButtons viewName="volcano" downloads={analysis.views.volcano.downloads} />
            <VolcanoChart data={analysis.views.volcano.data} />
          </article>

          <article className="card">
            <h2>Enrichment</h2>
            <DownloadButtons viewName="enrichment" downloads={analysis.views.enrichment.downloads} />
            <EnrichmentChart data={analysis.views.enrichment.data} />
          </article>
        </section>
      ) : null}
    </main>
  )
}

export default App
