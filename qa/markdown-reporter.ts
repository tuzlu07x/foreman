import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import type { Reporter, SerializedError, TestModule, Vitest } from 'vitest/node'
import { readQaMeta, type QaMeta } from './support/journey.js'

// =============================================================================
// Markdown QA report (`npm run qa` → qa/out/qa-report.md)
// =============================================================================
//
// One row per scenario (a vitest test in qa/scenarios): result, duration,
// and the steps with the evidence each one checked, as recorded by
// support/journey.ts. Written even when scenarios fail.

type Outcome = 'PASS' | 'FAIL' | 'SKIP'

interface Row {
  number: string
  file: string
  title: string
  outcome: Outcome
  durationMs: number
  meta: QaMeta | null
  errors: string[]
}

export const REPORT_PATH = 'qa/out/qa-report.md'

export default class MarkdownReporter implements Reporter {
  private ctx: Vitest | null = null
  private startedAt = Date.now()

  onInit(ctx: Vitest): void {
    this.ctx = ctx
    this.startedAt = Date.now()
  }

  // Vitest 4+ reports the finished run as TestModules (onFinished is gone).
  onTestRunEnd(modules: ReadonlyArray<TestModule>, errors: ReadonlyArray<SerializedError>): void {
    const root = this.ctx?.config.root ?? process.cwd()
    const rows = collectRows(modules, root)
    const out = join(root, REPORT_PATH)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, render(rows, [...errors], Date.now() - this.startedAt, root))
    const summary = count(rows)
    process.stdout.write(
      `\nQA report: ${relative(process.cwd(), out) || out} (${summary.PASS} passed, ${summary.FAIL} failed, ${summary.SKIP} skipped)\n`,
    )
  }
}

function collectRows(modules: ReadonlyArray<TestModule>, root: string): Row[] {
  const rows: Row[] = []
  for (const mod of [...modules].sort((a, b) => a.moduleId.localeCompare(b.moduleId))) {
    const tests = [...mod.children.allTests()]
    const rel = relative(root, mod.moduleId)
    if (tests.length === 0) {
      rows.push({
        number: scenarioNumber(mod.moduleId),
        file: rel,
        title: basename(mod.moduleId),
        outcome: mod.state() === 'failed' ? 'FAIL' : 'SKIP',
        durationMs: mod.diagnostic().duration,
        meta: null,
        errors: mod.errors().map((e) => e.message),
      })
      continue
    }
    for (const test of tests) {
      const result = test.result()
      rows.push({
        number: scenarioNumber(mod.moduleId),
        file: rel,
        title: test.name,
        outcome: result.state === 'passed' ? 'PASS' : result.state === 'failed' ? 'FAIL' : 'SKIP',
        durationMs: test.diagnostic()?.duration ?? 0,
        meta: readQaMeta(test.meta()),
        errors: result.state === 'failed' ? result.errors.map((e) => e.message) : [],
      })
    }
  }
  return rows
}

/** `qa/scenarios/03-tui-approvals.qa.ts` → `3`. */
function scenarioNumber(filepath: string): string {
  const m = /^(\d+)-/.exec(basename(filepath))
  return m?.[1] ? String(Number(m[1])) : '-'
}

function count(rows: Row[]): Record<Outcome, number> {
  const c: Record<Outcome, number> = { PASS: 0, FAIL: 0, SKIP: 0 }
  for (const r of rows) c[r.outcome] += 1
  return c
}

function render(rows: Row[], errors: unknown[], totalMs: number, root: string): string {
  const c = count(rows)
  const lines: string[] = []
  lines.push('# Foreman QA report', '')
  lines.push(`- Generated: ${new Date().toISOString()}`)
  lines.push(`- Foreman: ${version(root)} (${gitRevision(root)})`)
  lines.push(`- Node ${process.version} on ${process.platform}/${process.arch}`)
  lines.push(`- Result: **${c.PASS} passed, ${c.FAIL} failed, ${c.SKIP} skipped** in ${seconds(totalMs)}`)
  lines.push(
    '- Every scenario ran the built CLI (`dist/cli/index.js`) as real processes, in its own temporary',
    '  FOREMAN_HOME, HOME and working directory, with stub agent CLIs first on PATH and a guard that refuses',
    '  any network connection other than 127.0.0.1.',
    '',
  )
  lines.push('| # | Scenario | Result | Duration | Steps |', '| --- | --- | --- | --- | --- |')
  for (const r of rows) {
    const steps =
      r.meta && r.meta.steps.length > 0 ? `${r.meta.steps.filter((s) => s.status === 'passed').length}/${r.meta.steps.length}` : '-'
    lines.push(`| ${r.number} | ${escapeCell(r.title)} | ${r.outcome} | ${seconds(r.durationMs)} | ${steps} |`)
  }
  lines.push('')
  for (const r of rows) {
    lines.push(`## ${r.number}. ${r.title}: ${r.outcome} (${seconds(r.durationMs)})`, '')
    lines.push(`File: \`${r.file}\``, '')
    if (r.meta?.summary) lines.push(r.meta.summary, '')
    if (r.meta && r.meta.steps.length > 0) {
      for (const step of r.meta.steps) {
        lines.push(`- ${step.status === 'passed' ? 'PASS' : 'FAIL'} ${step.name} (${seconds(step.durationMs)})`)
        for (const e of step.evidence) lines.push(`  - ${e}`)
        if (step.error) lines.push(`  - error: ${oneLine(step.error)}`)
      }
      lines.push('')
    }
    if (r.meta && r.meta.notes.length > 0) {
      lines.push('Notes:', '')
      for (const n of r.meta.notes) lines.push(`- ${n}`)
      lines.push('')
    }
    if (r.errors.length > 0 && !(r.meta?.steps.some((s) => s.error))) {
      lines.push('Errors:', '')
      for (const e of r.errors) lines.push(`- ${oneLine(e)}`)
      lines.push('')
    }
  }
  if (errors.length > 0) {
    lines.push('## Unhandled errors', '')
    for (const e of errors) lines.push(`- ${oneLine(e instanceof Error ? e.message : String(e))}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

function seconds(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(0)}s` : `${(ms / 1000).toFixed(1)} s`
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 600)
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|')
}

function version(root: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { version?: string }
    return `v${pkg.version ?? '?'}`
  } catch {
    return 'v?'
  }
}

function gitRevision(root: string): string {
  const res = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf-8' })
  const rev = res.status === 0 ? res.stdout.trim() : 'unknown revision'
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf-8' })
  return dirty.status === 0 && dirty.stdout.trim().length > 0 ? `${rev}, uncommitted changes` : rev
}
