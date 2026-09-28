import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_POLICY_YAML } from '../../src/cli/policy-template.js'
import { checkPolicyYaml } from '../../src/core/doctor.js'
import { validatePolicyText } from '../../src/core/policy-load.js'

// QA #657 (docs pass) — doctor's policy_yaml check only parsed the YAML, so
// a file `foreman start` rejects (bad effect, unknown key) or a rule regex
// that can never match passed as "parses".
describe('doctor policy_yaml', () => {
  let home: string
  let saved: string | undefined
  const write = (text: string): void => writeFileSync(join(home, 'policy.yaml'), text)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'foreman-doctor-policy-'))
    saved = process.env.FOREMAN_HOME
    process.env.FOREMAN_HOME = home
  })
  afterEach(() => {
    if (saved === undefined) delete process.env.FOREMAN_HOME
    else process.env.FOREMAN_HOME = saved
    rmSync(home, { recursive: true, force: true })
  })

  it('passes the default template', () => {
    write(DEFAULT_POLICY_YAML)
    expect(checkPolicyYaml()).toMatchObject({ status: 'ok' })
  })

  it('fails a schema error with file, line and field', () => {
    write('rules:\n  - source: "*"\n    target: tool:read_file\n    effect: maybe\n')
    const row = checkPolicyYaml()
    expect(row.status).toBe('fail')
    expect(row.message).toMatch(/policy\.yaml failed to parse \(line 4\): rules\.0\.effect: Invalid enum value/)
    expect(row.message.startsWith(join(home, 'policy.yaml'))).toBe(true)
    expect(row.remediation).toContain('at line 4')
  })

  it('fails an unknown top-level key', () => {
    write('rulez: []\n')
    expect(checkPolicyYaml().status).toBe('fail')
  })

  it('fails a rule regex that can never compile, naming it', () => {
    write('rules:\n  - source: "*"\n    target: tool:read_file\n    effect: deny\n    conditions:\n      pathMatch: ["(unclosed"]\n')
    const row = checkPolicyYaml()
    expect(row.status).toBe('fail')
    expect(row.message).toContain('(line 6): rules.0.conditions: not a valid regular expression: "(unclosed"')
  })

  it('fails a YAML syntax error with its line', () => {
    write('rules:\n  - source: [broken\n')
    expect(checkPolicyYaml().message).toMatch(/failed to parse \(line \d+\): /)
  })

  it('validatePolicyText never touches the real database', () => {
    expect(validatePolicyText('/x/policy.yaml', 'rules: []\n')).toBeNull()
  })
})
