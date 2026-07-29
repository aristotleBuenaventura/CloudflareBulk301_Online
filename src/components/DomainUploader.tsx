import { useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { parseDomains } from '../lib/csvParser'

interface DomainUploaderProps {
  title: string
  description: string
  domains: string[]
  onChange: (domains: string[]) => void
  disabled?: boolean
  readOnly?: boolean
}

export function DomainUploader({
  title,
  description,
  domains,
  onChange,
  disabled,
  readOnly = false,
}: DomainUploaderProps) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [manual, setManual] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const locked = Boolean(disabled || readOnly)

  function mergeDomains(incoming: string[]) {
    if (readOnly) return
    const set = new Set(domains.map((d) => d.trim()).filter(Boolean))
    for (const d of incoming) {
      const trimmed = d.trim()
      if (trimmed) set.add(trimmed)
    }
    onChange(Array.from(set))
  }

  function handleAddManual(e: FormEvent) {
    e.preventDefault()
    if (readOnly) return
    const parsed = parseDomains(manual)
    if (parsed.length === 0) return
    mergeDomains(parsed)
    setManual('')
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    if (readOnly) return
    const file = e.target.files?.[0]
    if (!file) return
    const text = await file.text()
    const parsed = parseDomains(text)
    mergeDomains(parsed)
    setFileName(file.name)
    e.target.value = ''
  }

  function removeDomain(domain: string) {
    if (readOnly) return
    onChange(domains.filter((d) => d !== domain))
  }

  return (
    <section className="section domains-section">
      <div className="section-head">
        <div>
          <h2>{title}</h2>
          <p>
            {readOnly
              ? 'View only · admin can upload or edit domains'
              : description}
          </p>
        </div>
        <span className="count-badge">{domains.length}</span>
      </div>

      {!readOnly && (
        <>
          <div className="domains-toolbar">
            <button
              type="button"
              className="secondary-btn"
              disabled={locked}
              onClick={() => fileRef.current?.click()}
            >
              Upload CSV
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              hidden
              onChange={handleFile}
            />
            <button
              type="button"
              className="ghost-btn"
              disabled={locked || domains.length === 0}
              onClick={() => {
                onChange([])
                setFileName(null)
              }}
            >
              Clear
            </button>
            {fileName && <span className="file-chip">{fileName}</span>}
          </div>

          <form className="manual-add" onSubmit={handleAddManual}>
            <textarea
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder={'oldsite1.com\noldsite2.com'}
              rows={3}
              disabled={locked}
              spellCheck={false}
            />
            <button
              type="submit"
              className="secondary-btn"
              disabled={locked || !manual.trim()}
            >
              Add
            </button>
          </form>
        </>
      )}

      {domains.length > 0 && (
        <ul className="domain-list">
          {domains.map((domain) => (
            <li key={domain}>
              <span className="domain-name">{domain}</span>
              {!readOnly && (
                <button
                  type="button"
                  aria-label={`Remove ${domain}`}
                  disabled={locked}
                  onClick={() => removeDomain(domain)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
