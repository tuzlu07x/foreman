import { describe, expect, it } from 'vitest'
import {
  looksLikeVerification,
  parseVerification,
  VerificationParseError,
} from '../../../src/core/llm/parse-verification.js'

function happyJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_real_threat: true,
    threat_type: 'credential_theft',
    confidence: 0.85,
    explanation_short: 'Phishing pattern + .env read',
    explanation_long:
      'The agent received an email asking for API credentials and is now reading the .env file. Classic credential theft chain.',
    recommended_action: 'deny',
    additional_risk_score: 15,
    user_should_check: ['Sender of triggering email', 'Recent emails'],
    ...overrides,
  })
}

describe('parseVerification — happy path', () => {
  it('parses a valid response into typed core fields', () => {
    const out = parseVerification(happyJson())
    expect(out.is_real_threat).toBe(true)
    expect(out.threat_type).toBe('credential_theft')
    expect(out.confidence).toBe(0.85)
    expect(out.recommended_action).toBe('deny')
    expect(out.additional_risk_score).toBe(15)
    expect(out.user_should_check).toHaveLength(2)
  })

  it('strips ```json fenced output', () => {
    const fenced = '```json\n' + happyJson() + '\n```'
    expect(parseVerification(fenced).is_real_threat).toBe(true)
  })

  it('strips generic ``` fenced output', () => {
    const fenced = '```\n' + happyJson() + '\n```'
    expect(parseVerification(fenced).is_real_threat).toBe(true)
  })

  it('looksLikeVerification true on valid, false on garbage', () => {
    expect(looksLikeVerification(happyJson())).toBe(true)
    expect(looksLikeVerification('not json')).toBe(false)
  })
})

describe('parseVerification — strict validation', () => {
  it('rejects non-JSON text', () => {
    expect(() => parseVerification('I think this is a threat.')).toThrow(
      VerificationParseError,
    )
  })

  it('rejects unknown threat_type enum', () => {
    expect(() =>
      parseVerification(happyJson({ threat_type: 'mind_control' })),
    ).toThrow(VerificationParseError)
  })

  it('rejects confidence > 1', () => {
    expect(() =>
      parseVerification(happyJson({ confidence: 1.5 })),
    ).toThrow(VerificationParseError)
  })

  it('rejects confidence < 0', () => {
    expect(() =>
      parseVerification(happyJson({ confidence: -0.1 })),
    ).toThrow(VerificationParseError)
  })

  it('rejects additional_risk_score outside [-30, 30]', () => {
    expect(() =>
      parseVerification(happyJson({ additional_risk_score: 50 })),
    ).toThrow(VerificationParseError)
    expect(() =>
      parseVerification(happyJson({ additional_risk_score: -50 })),
    ).toThrow(VerificationParseError)
  })

  it('rejects extra fields (.strict())', () => {
    expect(() =>
      parseVerification(happyJson({ extra_field: 'no' })),
    ).toThrow(VerificationParseError)
  })

  it('rejects unknown recommended_action', () => {
    expect(() =>
      parseVerification(happyJson({ recommended_action: 'sue' })),
    ).toThrow(VerificationParseError)
  })

  it('rejects missing required field', () => {
    const partial = JSON.stringify({
      is_real_threat: false,
      // missing many fields
    })
    expect(() => parseVerification(partial)).toThrow(VerificationParseError)
  })

  it('rejects explanation_short over 120 chars (small headroom over the 90 prompt target)', () => {
    expect(() =>
      parseVerification(happyJson({ explanation_short: 'x'.repeat(200) })),
    ).toThrow(VerificationParseError)
  })

  it('VerificationParseError carries the raw response for debugging', () => {
    try {
      parseVerification('not json')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(VerificationParseError)
      if (err instanceof VerificationParseError) {
        expect(err.raw).toBe('not json')
      }
    }
  })
})

describe('parseVerification — edge cases', () => {
  it('accepts confidence = 0 and confidence = 1 exactly', () => {
    expect(parseVerification(happyJson({ confidence: 0 })).confidence).toBe(0)
    expect(parseVerification(happyJson({ confidence: 1 })).confidence).toBe(1)
  })

  it('accepts additional_risk_score = ±30 exactly', () => {
    expect(
      parseVerification(happyJson({ additional_risk_score: 30 }))
        .additional_risk_score,
    ).toBe(30)
    expect(
      parseVerification(happyJson({ additional_risk_score: -30 }))
        .additional_risk_score,
    ).toBe(-30)
  })

  it('accepts empty user_should_check array', () => {
    expect(
      parseVerification(happyJson({ user_should_check: [] }))
        .user_should_check,
    ).toEqual([])
  })

  it('rejects user_should_check over 8 entries', () => {
    expect(() =>
      parseVerification(
        happyJson({
          user_should_check: Array.from({ length: 10 }, () => 'x'),
        }),
      ),
    ).toThrow(VerificationParseError)
  })
})
