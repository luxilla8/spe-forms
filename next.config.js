/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Enable standalone output for Docker deployment
  output: 'standalone',

  // This app only exists to serve /api/contact for the Signature Properties
  // Elite site. Send anyone who lands on the root to the site itself instead
  // of the upstream demo form.
  async redirects() {
    const site = process.env.SITE_URL || 'https://spe-site-eight.vercel.app'
    return [{ source: '/', destination: site, permanent: false }]
  },
}

module.exports = nextConfig
