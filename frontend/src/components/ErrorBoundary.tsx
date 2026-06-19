"use client"

import React from "react"
import { reportBoundaryError } from "./useErrorCapture"

interface State {
  hasError: boolean
  error: Error | null
}

/**
 * Top-level React error boundary. Catches render-time
 * errors that would otherwise unmount the whole tree
 * and show a blank page. On error, posts to the
 * backend ErrorEvent table + shows a German recovery
 * message + a "Seite neu laden" button.
 *
 * Wrap your app root or page root in <ErrorBoundary>.
 * The boundary is intentionally minimal — no fancy
 * reset logic, no per-error routing. The goal is
 * "user sees a readable message, can reload, dev
 * sees the event in /dashboard/system-errors".
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  constructor(props: { children: React.ReactNode }) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // reportBoundaryError swallows its own failures
    // — never throws from here.
    reportBoundaryError(error, info.componentStack || "")
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-gray-800 rounded-lg shadow p-6 text-center">
            <div className="text-4xl mb-3" aria-hidden>⚠️</div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              Etwas ist schiefgelaufen
            </h1>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
              Ein unerwarteter Fehler ist aufgetreten. Der Fehler wurde
              automatisch gemeldet. Bitte laden Sie die Seite neu.
            </p>
            {this.state.error?.message && (
              <pre className="text-left text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded mb-4 overflow-auto max-h-32 text-gray-700 dark:text-gray-300">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={() => window.location.reload()}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium py-2 px-4 rounded"
            >
              Seite neu laden
            </button>
          </div>
        </main>
      )
    }
    return this.props.children
  }
}
