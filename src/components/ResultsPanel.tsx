import type { DomainResult } from '../types'

interface ResultsPanelProps {
  results: DomainResult[]
  currentDomain?: string | null
  live?: boolean
}

export function ResultsPanel({
  results,
  currentDomain = null,
  live = false,
}: ResultsPanelProps) {
  if (results.length === 0) return null

  const success = results.filter((r) => r.status === 'success').length
  const skipped = results.filter((r) => r.status === 'skipped').length
  const failed = results.filter((r) => r.status === 'failed').length
  const pending = results.filter((r) => r.status === 'pending').length

  return (
    <section className="panel results-panel">
      <header className="panel-header">
        <div>
          <h2>{live ? 'Live 301 progress' : 'Results'}</h2>
          <p>
            {live
              ? 'Updating as each old domain is redirected.'
              : 'Per-domain outcome from the latest apply run.'}
          </p>
        </div>
        <div className="result-counts">
          <span className="ok">{success} ok</span>
          <span className="skip">{skipped} skipped</span>
          <span className="fail">{failed} failed</span>
          {pending > 0 && <span className="pending">{pending} pending</span>}
        </div>
      </header>

      <ul className="results-list">
        {results.map((result) => {
          const isCurrent = currentDomain === result.domain
          return (
            <li
              key={result.domain}
              className={[
                'result-row',
                `status-${result.status}`,
                isCurrent ? 'is-current' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className="result-main">
                <strong>{result.domain}</strong>
                <span className="status-tag">
                  {isCurrent && result.status === 'pending'
                    ? 'running…'
                    : result.status}
                </span>
              </div>
              {result.message && (
                <p className="result-message">{result.message}</p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
