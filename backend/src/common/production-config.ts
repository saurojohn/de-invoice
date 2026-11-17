/**
 * Tier 855 — the production backend refuses to start with a configuration
 * that silently switches a protection off (security audit of 18.11.2026).
 *
 * Several protections hang on environment variables, and a wrong `.env` took
 * them away without a word:
 *  - `FINTS_PIN_ENC_KEY` empty: SMTP passwords (and FinTS PINs) were stored as
 *    typed (common/secret-crypto.ts falls back to plain text);
 *  - `SETUP_TOKEN` empty: the first person to reach /register of a new
 *    installation became its owner (a deploy by hand, without
 *    HETZNER-DEPLOY.sh, which writes one);
 *  - `ALLOW_HEADER_AUTH=1`: knowing a user's id was being that user;
 *  - `THROTTLE_DISABLED=1`: no rate limit on any route, the login included;
 *  - a mock of an outside service (VIES, the ECB rates, the bank): answers
 *    that are made up — VAT ids „valid“, exchange rates fixed.
 * A drill on the production images (not reachable from outside) may use the
 * mocks with `PRODUCTION_DRILL=1`; nothing else is let through.
 */
type Env = Record<string, string | undefined>

const on = (v: string | undefined) => ['1', 'true', 'yes'].includes(String(v ?? '').trim().toLowerCase())
const set = (v: string | undefined) => String(v ?? '').trim().length > 0

export function productionConfigProblems(env: Env = process.env): string[] {
  if (env.NODE_ENV !== 'production') return []
  const out: string[] = []
  const key = String(env.FINTS_PIN_ENC_KEY ?? '').trim()
  if (key.length < 32) {
    out.push('FINTS_PIN_ENC_KEY fehlt oder ist kürzer als 32 Zeichen — SMTP-Passwörter und FinTS-PINs würden unverschlüsselt gespeichert (openssl rand -hex 32; danach nie mehr ändern).')
  }
  if (!set(env.SETUP_TOKEN)) {
    out.push('SETUP_TOKEN fehlt — die erste Registrierung einer leeren Installation wäre für jeden offen, der die Adresse zuerst erreicht (openssl rand -hex 24).')
  }
  if (on(env.ALLOW_HEADER_AUTH)) {
    out.push('ALLOW_HEADER_AUTH=1 — der Header x-user-id würde ohne Passwort als Anmeldung gelten.')
  }
  if (on(env.THROTTLE_DISABLED)) {
    out.push('THROTTLE_DISABLED=1 — ohne Ratenbegrenzung, auch für die Anmeldung (nur für Lasttests).')
  }
  if (!on(env.PRODUCTION_DRILL)) {
    for (const name of ['VIES_MOCK', 'EXCHANGE_RATES_MOCK', 'FINTS_ALLOW_MOCK']) {
      if (on(env[name])) out.push(`${name}=1 — ein simulierter Dienst statt des echten (nur für Tests).`)
    }
  }
  return out
}
