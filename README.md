# spe-forms

The contact endpoint for the Signature Properties Elite website (`luxilla8/spe-site`). A fork of [GitForms](https://github.com/Luigigreco/gitforms), which turns each form submission into a GitHub Issue, so there is no database and no monthly fee. GitHub's own notifications email the repo owner for every new issue.

```
Site form (index.html)  →  POST /api/contact on this app  →  one Issue in luxilla8/spe-leads  →  email notification
```

## What changed from upstream

- `src/app/api/contact/route.ts` accepts the site's fields (`name`, `email`, `phone`, `goal`, `message`) instead of first/last/company, writes the issue in English, labels first-time buyers, sellers and retirement moves, and answers a plain form post (the site's no-JS fallback) with a redirect back to the site.
- `config/fields.json` mirrors those fields so the app's own demo page still works.
- Tests updated to match.

Upstream's rate limiting (3 per minute per IP), honeypot, sanitization and spam scoring are unchanged.

## Environment variables (Vercel project `spe-forms`, EAP team)

| Name | Value | Notes |
|---|---|---|
| `GITHUB_TOKEN` | fine-grained PAT | **Only** repository `luxilla8/spe-leads`, permission Issues: Read and write. Nothing else. Mark Sensitive in Vercel. |
| `GITHUB_REPO` | `luxilla8/spe-leads` | private repo that receives the issues |
| `ALLOWED_ORIGIN` | the site's origin | `https://spe-site-eight.vercel.app` until the real domain is live, then the real domain |
| `SITE_URL` | same as `ALLOWED_ORIGIN` | where a no-JS form post is redirected back to |
| `ANTHROPIC_API_KEY` | optional | turns on the AI intent/urgency labels; leave unset |

## Local

```bash
npm install
cp .env.example .env.local   # fill in the values above
npm run dev                  # http://localhost:3000
npm test
```

## Deploy

Vercel, framework Next.js, no special settings. Pushes to `main` deploy production.
