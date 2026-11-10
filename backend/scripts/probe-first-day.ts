/**
 * Tier 825 — probe for e2e/523: the rules of the first day that a running test
 * backend cannot show (it is not production, its database is not empty).
 * Prints one JSON line.
 *
 *   npx ts-node -T scripts/probe-first-day.ts
 */
import { setupTokenMatches, setupTokenRequired } from '../src/modules/auth/registration'
import { MailService, NO_MAIL_SERVER_MESSAGE } from '../src/modules/mail/mail.service'

async function mailWithoutServer(nodeEnv: string): Promise<string> {
  const saved = { ...process.env }
  process.env.NODE_ENV = nodeEnv
  for (const k of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) delete process.env[k]
  // no company mail server either
  const prisma = { mailConfig: { findUnique: async () => null } } as never
  const mail = new MailService(prisma)
  ;(mail as unknown as { logger: { warn: () => void; log: () => void } }).logger = { warn: () => undefined, log: () => undefined }
  const out: string[] = []
  try {
    await mail.assertMaySend('c1')
    out.push('assert:ok')
  } catch (e) {
    out.push('assert:' + ((e as Error).message === NO_MAIL_SERVER_MESSAGE ? 'refused' : 'other'))
  }
  try {
    const r = await mail.send('c1', { to: 'a@example.test', subject: 'x', text: 'y' })
    out.push('send:' + (r.messageId.startsWith('dev-') ? 'logged' : 'sent'))
  } catch (e) {
    out.push('send:' + ((e as Error).message === NO_MAIL_SERVER_MESSAGE ? 'refused' : 'other'))
  }
  process.env = saved
  return out.join(' ')
}

async function main() {
  const env = { SETUP_TOKEN: 'abc123def456' }
  console.log(JSON.stringify({
    requiredEmptyWithToken: setupTokenRequired('empty', env),
    requiredEmptyWithout: setupTokenRequired('empty', {}),
    requiredOnceACompanyExists: setupTokenRequired('setting', env) || setupTokenRequired('default', env),
    matches: setupTokenMatches('abc123def456', env),
    matchesTrimmed: setupTokenMatches(' abc123def456 ', env),
    wrong: setupTokenMatches('abc123def457', env),
    shorter: setupTokenMatches('abc', env),
    notAString: setupTokenMatches(42, env),
    noTokenSet: setupTokenMatches('', {}),
    production: await mailWithoutServer('production'),
    development: await mailWithoutServer('development'),
  }))
}
main().catch((e) => { console.log(JSON.stringify({ error: String(e) })); process.exit(1) })
