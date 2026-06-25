"use client"

// Tier 12: mirrors the auth tokens from
// localStorage into cookies. The Next.js
// middleware (src/middleware.ts) reads
// those cookies to decide whether to
// serve /dashboard/* or redirect to
// /login. Without this mirror, the
// middleware would always see empty
// cookies (localStorage is invisible
// to the server) and bounce every
// authed user back to the login page.
//
// We sync the cookies on every page
// load. The middleware also has its
// own short-circuit for the /dashboard
// route, so the cookie state is what
// actually drives the auth gate.

import { useEffect } from "react"

export default function AuthCookieSync() {
  useEffect(() => {
    if (typeof document === "undefined") return
    const userId = localStorage.getItem("userId")
    const companyId = localStorage.getItem("companyId")
    // Set the cookie if it differs from
    // the current value. document.cookie
    // is the only client-side API for
    // this — we use a 1-day expiry
    // matching the JWT TTL.
    const oneDay = 60 * 60 * 24
    if (userId) {
      document.cookie = `x-user-id=${encodeURIComponent(userId)}; path=/; max-age=${oneDay}; SameSite=Lax`
    } else {
      document.cookie = "x-user-id=; path=/; max-age=0"
    }
    if (companyId) {
      document.cookie = `x-company-id=${encodeURIComponent(companyId)}; path=/; max-age=${oneDay}; SameSite=Lax`
    } else {
      document.cookie = "x-company-id=; path=/; max-age=0"
    }
  }, [])
  return null
}