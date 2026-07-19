import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { THEME_PREHYDRATION_SCRIPT } from "@/components/useTheme";
import { ToastProvider } from "@/components/useToast";
import { GlobalErrorCapture } from "@/components/GlobalErrorCapture";
import AuthCookieSync from "@/components/AuthCookieSync";
import GlobalSearch from "@/components/GlobalSearch";

// Geist only ships Latin glyphs by default. We need:
//   - "latin"      for English (A-Z, a-z, basic punctuation)
//   - "latin-ext"  for German umlauts ä/ö/ü/ß, French accents, etc.
//                    (the project is a German invoice app, so the
//                    primary UI language is German and umlauts appear
//                    all over the labels: "Fälligkeitsdatum",
//                    "Geschäftsführer", "Rechnungsempfänger", etc.)
//
// For Chinese characters we fall back to system CJK fonts in
// globals.css (body { font-family: ... }) — Geist doesn't include
// CJK glyphs, and Noto Sans SC (the main web-CJK alternative) is
// 3+ MB bundled, too heavy for a German primary-language app.
// The OS CJK fonts (PingFang SC on macOS, Microsoft YaHei on
// Windows, Source Han Sans CN on Linux) are decent and already
// installed on every developer's machine.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "latin-ext"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "de-invoice",
  description: "Rechnungen, Buchhaltung, DATEV — GoBD-konform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      // The pre-hydration Script (below) reads
      // localStorage + OS preference and adds the
      // `dark` class to <html> BEFORE React hydrates.
      // Without it the page would render light-mode
      // for ~50ms on every load (white flash) before
      // the useTheme hook could run. The className
      // here stays neutral (no dark:) — the Script
      // does the flipping. suppressHydrationWarning
      // is needed because the script mutates the
      // class on <html> after SSR.
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        {/*
         * strategy="beforeInteractive" — runs in
         * <head> before any body markup. The script
         * is a one-liner that reads localStorage +
         * matchMedia and toggles the .dark class on
         * <html>. This is THE difference between a
         * polished dark-mode UX and a flash-of-light
         * on every page load.
         */}
        <Script
          id="theme-pre-hydration"
          strategy="beforeInteractive"
        >
          {THEME_PREHYDRATION_SCRIPT}
        </Script>
      </head>
      <body className="min-h-full flex flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100"><AuthCookieSync /><ToastProvider><GlobalErrorCapture>{children}</GlobalErrorCapture><GlobalSearch /></ToastProvider></body>
    </html>
  );
}
