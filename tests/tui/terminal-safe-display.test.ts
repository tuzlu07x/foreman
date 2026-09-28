import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import type { ApprovalRequest } from '../../src/core/approval.js'
import { generateReport } from '../../src/core/security-report.js'
import { ApprovalModal } from '../../src/tui/components/approval-modal.js'
import { summariseTool, targetLabel } from '../../src/tui/format.js'

// #656 (H2): the approval modal and the activity feed show hidden
// characters in agent-supplied text instead of passing them to the
// terminal. Built with fromCodePoint so this file holds none itself.
const ESC = String.fromCodePoint(0x1b)
const RLO = String.fromCodePoint(0x202e)
const ATTACK_PATH = `x${ESC}[2K\rdocs/README.md${ESC}[8m/.env`

function stripSgr(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    requestId: 'req-h2',
    sourceAgent: 'qa-bot',
    targetTool: 'read_file',
    args: { path: ATTACK_PATH },
    riskScore: 60,
    riskReasons: ['secret_path'],
    riskFactors: [
      { rule: 'secret_path', category: 'secret', points: 60, reason: `.env-style file ${RLO}txt.`, evidence: ATTACK_PATH },
    ],
    riskBucket: 'high',
    llmVerification: null,
    securityReport: null,
    ...overrides,
  }
}

/** Nothing from the agent reaches the terminal as a control sequence:
 *  no erase-line, no concealed text, no carriage return, no bidi. */
function expectInert(frame: string): void {
  expect(frame).not.toContain(`${ESC}[2K`)
  expect(frame).not.toContain(`${ESC}[8m`)
  expect(frame).not.toContain('\r')
  expect(frame).not.toContain(RLO)
}

describe('approval modal shows hidden characters (#656)', () => {
  it('legacy layout: the path is shown whole, escapes made visible', () => {
    const { lastFrame } = render(React.createElement(ApprovalModal, { request: request(), remainingSeconds: 40 }))
    const frame = lastFrame() ?? ''
    expectInert(frame)
    expect(stripSgr(frame)).toContain('read_file("x␛[2K␍docs/README.md␛[8m/.env")')
    expect(stripSgr(frame)).toContain('⟨U+202E⟩txt.')
  })

  it('report layout: summary, narrative and technical detail are inert too', () => {
    const args = { path: ATTACK_PATH }
    const securityReport = generateReport({
      sourceAgent: 'qa-bot',
      targetTool: 'read_file',
      args,
      assessment: {
        factors: request().riskFactors,
        totalScore: 60,
        bucket: 'high',
        recommendation: 'ask',
        llmVerification: null,
      },
    })
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: request({ securityReport, context: `note ${ESC}[2Kgone` }),
        remainingSeconds: 40,
        technicalExpanded: true,
      }),
    )
    const frame = lastFrame() ?? ''
    expectInert(frame)
    expect(stripSgr(frame)).toContain('␛[2K')
  })

  it('agent ids and tool names are inert', () => {
    const { lastFrame } = render(
      React.createElement(ApprovalModal, {
        request: request({ sourceAgent: `evil${ESC}[2J`, targetAgent: `x${RLO}y`, targetTool: `t${ESC}[8mool` }),
        remainingSeconds: 40,
      }),
    )
    const frame = lastFrame() ?? ''
    expect(frame).not.toContain(`${ESC}[2J`)
    expectInert(frame)
    expect(stripSgr(frame)).toContain('evil␛[2J')
  })
})

describe('activity feed / logs formatting (#656)', () => {
  it('summariseTool and targetLabel never pass escapes through', () => {
    const summary = summariseTool('list_files', JSON.stringify({ path: `${ESC}[1K\r${ESC}[32mALLOWED-LOOKING-TEXT` }))
    expect(summary).toBe('list_files("␛[1K␍␛[32mALLOWED-LOOKING-TEXT")')
    expect(targetLabel(`a${ESC}]0;PWNED\u0007`, `b${RLO}`)).toBe('a␛]0;PWNED␇ → b⟨U+202E⟩')
  })
})
