import type { TaskMeta } from 'vitest'

// =============================================================================
// Journeys — a QA scenario as a list of steps with evidence
// =============================================================================
//
// A scenario is one vitest test. Each step records how long it took and the
// evidence it checked (audit rows, CLI output, screen text). The record
// travels to the Markdown reporter on the task's `meta`.

export interface QaStep {
  name: string
  status: 'passed' | 'failed'
  durationMs: number
  evidence: string[]
  error?: string
}

export interface QaMeta {
  scenario: string
  summary: string
  steps: QaStep[]
  notes: string[]
}

export function readQaMeta(meta: TaskMeta | undefined): QaMeta | null {
  const qa = (meta as { qa?: unknown } | undefined)?.qa
  if (!qa || typeof qa !== 'object') return null
  const candidate = qa as Partial<QaMeta>
  return Array.isArray(candidate.steps) && typeof candidate.scenario === 'string' ? (qa as QaMeta) : null
}

export class Journey {
  private readonly record: QaMeta

  constructor(task: { meta: TaskMeta }, scenario: string, summary: string) {
    this.record = { scenario, summary, steps: [], notes: [] }
    Object.assign(task.meta, { qa: this.record })
  }

  /** Run one step. `evidence(line)` adds a line to the report. */
  async step<T>(name: string, fn: (evidence: (line: string) => void) => Promise<T> | T): Promise<T> {
    const step: QaStep = { name, status: 'passed', durationMs: 0, evidence: [] }
    this.record.steps.push(step)
    const started = Date.now()
    try {
      return await fn((line) => {
        step.evidence.push(oneLine(line))
      })
    } catch (err) {
      step.status = 'failed'
      step.error = err instanceof Error ? err.message : String(err)
      throw err
    } finally {
      step.durationMs = Date.now() - started
    }
  }

  /** Something worth reading in the report that is not a failure. */
  note(text: string): void {
    this.record.notes.push(oneLine(text))
  }

  /** Skip the scenario, saying why in the report. */
  skip(context: { skip: () => void }, reason: string): void {
    this.note(`Skipped: ${reason}`)
    context.skip()
  }
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 400 ? `${flat.slice(0, 399)}…` : flat
}
