import { describe, expect, it } from 'vitest'
import { roomDisposition, taskDisposition } from '../lib/jinyiwei-disposition'

describe('jinyiwei disposition ladder', () => {
  it('uses a progressive enforcement ladder instead of 闭关 wording', () => {
    expect(taskDisposition({ status: 'paused', errorCount: 0 }).label).toBe('看守')
    expect(taskDisposition({ status: 'active', errorCount: 1 }).label).toBe('看守')
    expect(taskDisposition({ status: 'active', errorCount: 2 }).label).toBe('拘押')
    expect(taskDisposition({ status: 'active', errorCount: 3 }).label).toBe('囚禁')
  })

  it('maps paused rooms to 看守 without using 闭关 as a Jinyiwei action', () => {
    const disposition = roomDisposition('paused')
    expect(disposition.label).toBe('看守')
    expect(disposition.description).not.toContain('闭关')
  })
})
