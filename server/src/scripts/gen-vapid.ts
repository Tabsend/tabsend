import webpush from 'web-push'

/**
 * Generate an explicit VAPID keypair override. Normal relay boot provisions and
 * persists keys automatically; this command remains for operators who intentionally
 * manage the keypair outside the relay database. Print as env lines so the output can
 * be appended straight to a `.env`:
 *
 *   pnpm --filter @tabsend/server gen:vapid >> server/.env
 */
const keys = webpush.generateVAPIDKeys()
process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\n`)
process.stdout.write(`VAPID_PRIVATE_KEY=${keys.privateKey}\n`)
process.stdout.write('VAPID_SUBJECT=mailto:you@example.com\n')
