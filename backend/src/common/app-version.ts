/**
 * Tier 828 — which code is running. The images are built with the git commit
 * and the build time (infra/prod/build.sh → build args GIT_COMMIT /
 * BUILD_TIME → APP_COMMIT / APP_BUILT_AT); without them (a build by hand, the
 * development server) both are null. „Systembetrieb" shows them, so that after
 * an update or a rollback the operator sees what the server runs.
 */
export function appVersion(): { commit: string | null; builtAt: string | null } {
  const commit = String(process.env.APP_COMMIT || '').trim()
  const builtAt = String(process.env.APP_BUILT_AT || '').trim()
  return {
    commit: /^[0-9a-f]{7,40}$/i.test(commit) ? commit.toLowerCase() : null,
    builtAt: builtAt && !Number.isNaN(Date.parse(builtAt)) ? new Date(builtAt).toISOString() : null,
  }
}
