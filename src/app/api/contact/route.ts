import { NextRequest, NextResponse } from 'next/server'
import { checkRateLimit } from '../../../lib/rateLimit'
import { sanitizeText, sanitizeEmail } from '../../../lib/sanitize'
import { calculateSpamScore } from '../../../lib/spamScore'
import { classifyLead } from '../../../lib/classify'
import translations from '../../../../config/translations.json'

/**
 * Contact endpoint for the Signature Properties Elite site.
 *
 * Accepts the site's fields (name, email, phone, goal, message) as JSON
 * (fetch from the page) or as form-encoded (the no-JS fallback, which is
 * answered with a redirect back to the site). Every submission becomes one
 * GitHub Issue in GITHUB_REPO; GitHub's own notifications email the owner.
 */

type Locale = 'en' | 'it'
type TranslationMessages = typeof translations.en.messages

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'
// Where a no-JS form post is sent back to. Falls back to the allowed origin.
const SITE_URL = process.env.SITE_URL || (ALLOWED_ORIGIN !== '*' ? ALLOWED_ORIGIN : '')

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  }
}

function getLocale(request: NextRequest): Locale {
  const acceptLanguage = request.headers.get('accept-language') ?? ''
  return acceptLanguage.toLowerCase().includes('it') ? 'it' : 'en'
}

function msg(locale: Locale, key: keyof TranslationMessages, vars?: Record<string, string | number>): string {
  const t = translations[locale]?.messages ?? translations.en.messages
  let text: string = (t as TranslationMessages)[key] ?? (translations.en.messages[key] as string)
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replace(`{${k}}`, String(v))
    }
  }
  return text
}

interface ContactFormData {
  name?: string
  email?: string
  phone?: string
  goal?: string
  message?: string
  // Honeypot: must stay empty for real users
  website?: string
}

const GOALS = new Set([
  'Buy my first home',
  'Buy a home',
  'Sell my home',
  'Plan a move for retirement',
  'Not sure yet',
])

function str(v: FormDataEntryValue | null | undefined): string {
  return typeof v === 'string' ? v : ''
}

/** Read the body as JSON or as a form post. Returns the data and which kind it was. */
async function readBody(request: NextRequest): Promise<{ data: ContactFormData; isForm: boolean }> {
  const ct = request.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) {
    return { data: (await request.json()) as ContactFormData, isForm: false }
  }
  const fd = await request.formData()
  return {
    data: {
      name: str(fd.get('name')),
      email: str(fd.get('email')),
      phone: str(fd.get('phone')),
      goal: str(fd.get('goal')),
      message: str(fd.get('message')),
      website: str(fd.get('website')),
    },
    isForm: true,
  }
}

function reply(isForm: boolean, status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
  if (isForm && SITE_URL) {
    const ok = status < 400
    const url = `${SITE_URL.replace(/\/$/, '')}/?${ok ? 'sent=1' : 'error=1'}#form`
    return NextResponse.redirect(url, { status: 303, headers: extraHeaders })
  }
  return NextResponse.json(body, { status, headers: { ...corsHeaders(), ...extraHeaders } })
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() })
}

export async function POST(request: NextRequest) {
  const locale = getLocale(request)
  let isForm = false

  try {
    // Rate limiting
    const ip =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
      request.headers.get('x-real-ip') ??
      'unknown'

    const rateCheck = checkRateLimit(ip)
    if (!rateCheck.allowed) {
      return reply(isForm, 429, { error: msg(locale, 'tooManyRequests', { seconds: rateCheck.retryAfter }) }, {
        'Retry-After': String(rateCheck.retryAfter),
        'X-RateLimit-Remaining': '0',
      })
    }

    const parsed = await readBody(request)
    isForm = parsed.isForm
    const body = parsed.data

    // Honeypot: pretend success so bots learn nothing
    if (body.website && body.website.trim().length > 0) {
      return reply(isForm, 200, { success: true })
    }

    // Sanitize
    const name = sanitizeText(body.name ?? '', 120)
    const email = sanitizeEmail(body.email ?? '')
    const phone = body.phone ? sanitizeText(body.phone, 40) : ''
    const goalRaw = body.goal ? sanitizeText(body.goal, 60) : ''
    const goal = GOALS.has(goalRaw) ? goalRaw : goalRaw ? 'Other' : 'Not given'
    const message = body.message ? sanitizeText(body.message, 5000) : ''

    // Validate
    if (!name || !email) {
      return reply(isForm, 400, { error: msg(locale, 'requiredFields') })
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (!emailRegex.test(email)) {
      return reply(isForm, 400, { error: msg(locale, 'invalidEmail') })
    }

    // GitHub config
    const GITHUB_TOKEN = process.env.GITHUB_TOKEN
    const GITHUB_REPO = process.env.GITHUB_REPO
    if (!GITHUB_TOKEN || !GITHUB_REPO) {
      console.error('Missing GitHub configuration')
      return reply(isForm, 500, { error: msg(locale, 'configError') })
    }
    const [owner, repo] = GITHUB_REPO.split('/')
    if (!owner || !repo) {
      console.error('Invalid GITHUB_REPO format')
      return reply(isForm, 500, { error: msg(locale, 'configError') })
    }

    // Spam scoring (the scorer expects the upstream field names)
    const spamScore = calculateSpamScore({
      firstName: name,
      lastName: '',
      email,
      company: goal,
      message: message || `${goal} inquiry`,
    })
    if (spamScore >= 80) {
      return reply(isForm, 200, { success: true })
    }

    // Optional AI classification (no-op without ANTHROPIC_API_KEY)
    const classification = await classifyLead(message || goal)

    const labels: string[] = ['inquiry']
    if (goal === 'Buy my first home') labels.push('first-time-buyer')
    else if (goal === 'Sell my home') labels.push('seller')
    else if (goal === 'Plan a move for retirement') labels.push('retirement')
    if (spamScore >= 50) labels.push('suspected-spam')
    if (classification.urgency === 'high') labels.push('urgent')

    const dateStr = new Date().toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })

    const aiSection = classification.summary
      ? `\n## AI summary\n\n- **Intent:** ${classification.intent}\n- **Urgency:** ${classification.urgency}\n- **Summary:** ${classification.summary}\n`
      : ''

    const issueBody = `# New inquiry from the website

**Name:** ${name}
**Email:** ${email}
**Phone:** ${phone || 'Not given'}
**Looking to:** ${goal}
**Received:** ${dateStr} (Central Time)
${aiSection}
## Message

${message || '_No message left._'}

---
_Reply to this person directly at ${email}${phone ? ' or ' + phone : ''}. Close this issue once you have followed up._
`

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `${name} wants to: ${goal}`,
        body: issueBody,
        labels,
      }),
    })

    if (!response.ok) {
      console.error('Failed to save contact', await response.text())
      return reply(isForm, 500, { error: msg(locale, 'saveError') })
    }

    return reply(isForm, 201, { success: true, message: msg(locale, 'success') })
  } catch (error) {
    console.error('Error:', error)
    return reply(isForm, 500, { error: msg(locale, 'unexpectedError') })
  }
}
