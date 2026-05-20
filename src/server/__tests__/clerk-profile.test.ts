import type Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initTestDb } from '../../shared/__tests__/helpers/test-db'

const { mockExecuteAgent } = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn()
}))

vi.mock('../../shared/agent-executor', () => ({
  executeAgent: mockExecuteAgent
}))

import { executeClerkWithFallback } from '../clerk-profile'

let db: Database.Database

beforeEach(() => {
  db = initTestDb()
  mockExecuteAgent.mockReset()
  delete process.env.OPENAI_API_KEY
  delete process.env.GEMINI_API_KEY
  delete process.env.MIMO_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.ANTHROPIC_AUTH_TOKEN
  delete process.env.ANTHROPIC_BASE_URL
})

afterEach(() => {
  db.close()
})

describe('executeClerkWithFallback', () => {
  it('falls back to next model when codex attempt times out', async () => {
    mockExecuteAgent
      .mockResolvedValueOnce({
        output: '',
        exitCode: 124,
        durationMs: 20_000,
        sessionId: null,
        timedOut: true,
        usage: { inputTokens: 120, outputTokens: 0 }
      })
      .mockResolvedValueOnce({
        output: 'Recovered on fallback model',
        exitCode: 0,
        durationMs: 1_200,
        sessionId: 'session-fallback',
        timedOut: false,
        usage: { inputTokens: 80, outputTokens: 30 }
      })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'codex',
      prompt: 'latest room logs',
      systemPrompt: 'commentary'
    })

    expect(result.ok).toBe(true)
    expect(result.model).toBe('claude')
    expect(result.usedFallback).toBe(true)
    expect(result.attempts).toHaveLength(1)
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 30 })
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2)
    expect(mockExecuteAgent.mock.calls[0][0]).toMatchObject({ model: 'codex' })
    expect(mockExecuteAgent.mock.calls[1][0]).toMatchObject({ model: 'claude' })
  })

  it('still fails fast on non-transient errors', async () => {
    mockExecuteAgent.mockResolvedValueOnce({
      output: 'Fatal validation error',
      exitCode: 1,
      durationMs: 40,
      sessionId: null,
      timedOut: false,
      usage: { inputTokens: 20, outputTokens: 0 }
    })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'codex',
      prompt: 'do work',
      systemPrompt: 'system'
    })

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Fatal validation error')
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1)
  })

  it('passes MiMo API credentials into the execution candidate', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    mockExecuteAgent.mockResolvedValueOnce({
      output: 'MiMo answered',
      exitCode: 0,
      durationMs: 900,
      sessionId: 'mimo-session',
      timedOut: false,
      usage: { inputTokens: 42, outputTokens: 12 }
    })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'mimo:MiMo-V2.5-Pro',
      prompt: '江湖现在怎样',
      systemPrompt: '天机阁'
    })

    expect(result.ok).toBe(true)
    expect(result.model).toBe('mimo:MiMo-V2.5-Pro')
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1)
    expect(mockExecuteAgent.mock.calls[0][0]).toMatchObject({
      model: 'mimo:MiMo-V2.5-Pro',
      apiKey: 'mimo-test-key',
    })
  })

  it('falls back from an unavailable subscription CLI to MiMo', async () => {
    process.env.MIMO_API_KEY = 'mimo-test-key'
    mockExecuteAgent
      .mockResolvedValueOnce({
        output: 'Claude CLI not found',
        exitCode: 1,
        durationMs: 50,
        sessionId: null,
        timedOut: false,
        usage: { inputTokens: 10, outputTokens: 0 }
      })
      .mockResolvedValueOnce({
        output: 'MiMo fallback answered',
        exitCode: 0,
        durationMs: 900,
        sessionId: 'mimo-fallback-session',
        timedOut: false,
        usage: { inputTokens: 40, outputTokens: 14 }
      })

    const result = await executeClerkWithFallback({
      db,
      preferredModel: 'claude',
      prompt: '需要 AI 回答',
      systemPrompt: '天机阁'
    })

    expect(result.ok).toBe(true)
    expect(result.model).toBe('mimo:MiMo-V2.5-Pro')
    expect(result.usedFallback).toBe(true)
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2)
  })
})
