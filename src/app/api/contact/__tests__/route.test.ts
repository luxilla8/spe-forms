import { describe, test, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST } from '../route'

// Mock the GitHub fetch call
const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// Set required env vars
vi.stubEnv('GITHUB_TOKEN', 'test-token')
vi.stubEnv('GITHUB_REPO', 'testowner/testrepo')

function makeRequest(body: Record<string, unknown>, headers?: Record<string, string>) {
  return new NextRequest('http://localhost/api/contact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Language': 'en',
      'x-forwarded-for': '10.0.0.' + Math.floor(Math.random() * 200 + 50), // avoid rate limit
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

const validBody = {
  name: 'Test Person',
  email: 'test@example.com',
  phone: '601-555-0100',
  goal: 'Buy my first home',
  message: 'We are hoping to buy our first house next spring and do not know where to start.',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockFetch.mockResolvedValue(new Response(JSON.stringify({ id: 1 }), { status: 201 }))
})

describe('POST /api/contact', () => {
  test('returns 400 when required fields are missing', async () => {
    const res = await POST(makeRequest({ name: 'Only a name' }))
    expect(res.status).toBe(400)
  })

  test('returns 400 for invalid email', async () => {
    const res = await POST(makeRequest({ ...validBody, email: 'not-an-email' }))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBeTruthy()
  })

  test('returns 201 on valid submission and labels first-time buyers', async () => {
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.success).toBe(true)
    const issue = JSON.parse(mockFetch.mock.calls[0][1].body)
    expect(issue.labels).toContain('first-time-buyer')
    expect(issue.title).toBe('Test Person wants to: Buy my first home')
  })

  test('accepts a submission with no message', async () => {
    const res = await POST(makeRequest({ name: 'Quiet Person', email: 'q@example.com', goal: 'Not sure yet' }))
    expect(res.status).toBe(201)
  })

  test('silently accepts honeypot submissions without calling GitHub', async () => {
    const res = await POST(makeRequest({ ...validBody, website: 'http://spam.example' }))
    expect(res.status).toBe(200)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  test('returns 429 after the rate limit is exceeded from one IP', async () => {
    const headers = { 'x-forwarded-for': '10.9.9.9' }
    for (let i = 0; i < 3; i++) await POST(makeRequest(validBody, headers))
    const res = await POST(makeRequest(validBody, headers))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBeTruthy()
  })

  test('returns 500 when GitHub rejects the issue', async () => {
    mockFetch.mockResolvedValueOnce(new Response('nope', { status: 401 }))
    const res = await POST(makeRequest(validBody))
    expect(res.status).toBe(500)
  })
})
