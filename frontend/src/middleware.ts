// Tier 12: Next.js middleware for auth.
//
// Without this middleware, ANY visit to
// /dashboard/* in a fresh tab / incognito
// window would briefly render the dashboard
// shell (with the loading state) before
// the client-side auth check runs and
// redirects to /login. Two problems:
//
//   1. The user sees a flash of "logged in"
//      content before being redirected.
//   2. Search-engine crawlers and link
//      previews (Slack, iMessage) can
//      index the dashboard contents.
//
// The middleware reads the `userId` +
// `companyId` tokens from localStorage via
// a cookie (we mirror the same value into
// a cookie on login so the server-side
// middleware can read it). If either is
// missing, redirect to /login.
//
// We DO NOT validate the token server-side
// here — that's the job of the backend's
// HeaderAuthGuard on the first API call.
// The middleware is a UX / privacy gate,
// not a security gate. A bad cookie still
// gets you a 401 from the API on the very
// first request.
//
// We also run this on /login?from=... so
// a deep link from Slack / iMessage lands
// the user on the dashboard after auth
// (the login page reads `from` from the
// URL and uses it as the post-login
// redirect target).
//
// The matcher limits the middleware to
// non-API, non-_next, non-static routes.
// This is the standard Next.js pattern.

import { NextRequest, NextResponse } from "next/server"

export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl
  // Only guard /dashboard/* — everything
  // else (the marketing site, /login,
  // /register, /reset-password) is public.
  if (!pathname.startsWith("/dashboard")) {
    return NextResponse.next()
  }
  // The auth tokens are stored in
  // localStorage by the frontend, which
  // is NOT visible to the middleware. We
  // mirror them into a cookie on every
  // request (see the layout's
  // syncAuthCookie effect) so the server
  // can see them here. If the cookie
  // is missing or empty, redirect to
  // /login.
  //
  // Tier 401: the real credential is `de_session`, the httpOnly cookie the
  // backend sets at login — the middleware can read it (httpOnly hides it from
  // JavaScript, not from the server) and it is the only one of these three a
  // visitor cannot write by hand. The legacy mirrored `x-user-id` cookie is
  // still accepted because the e2e suites seed it without logging in; with
  // ALLOW_HEADER_AUTH=0 it buys an attacker nothing, since the API behind this
  // page answers 401 without a session.
  const session = req.cookies.get("de_session")?.value
  const userId = req.cookies.get("x-user-id")?.value
  const companyId = req.cookies.get("x-company-id")?.value
  if ((!session && !userId) || !companyId) {
    const loginUrl = new URL("/login", req.url)
    // Carry the original target through
    // the auth redirect so we can come
    // back to it after the user signs in.
    // The login page reads `from` and
    // uses it as the post-login redirect.
    if (pathname !== "/dashboard") {
      loginUrl.searchParams.set("from", pathname + search)
    }
    return NextResponse.redirect(loginUrl)
  }
  return NextResponse.next()
}

export const config = {
  // Match all paths except _next assets,
  // API routes, and static files.
  // The negative-lookahead (?!_next) keeps
  // HMR / chunks out of the middleware
  // path so the dev server isn't slowed
  // down.
  matcher: ["/((?!_next|api|favicon.ico|.*\\..*).*)"],
}