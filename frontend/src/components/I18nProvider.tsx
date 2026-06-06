"use client"

import { useState, useEffect, createContext, useContext } from "react"
import deMessages from "../../../messages/de.json"
import zhMessages from "../../../messages/zh.json"

type Messages = typeof deMessages

const messages: Record<string, Messages> = {
  de: deMessages,
  zh: zhMessages,
}

interface I18nContextType {
  locale: string
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextType>({
  locale: "de",
  t: (key: string) => key,
})

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState("de")

  useEffect(() => {
    const saved = localStorage.getItem("locale") || "de"
    setLocale(saved)
  }, [])

  const t = (key: string): string => {
    const keys = key.split(".")
    let value: any = messages[locale]
    for (const k of keys) {
      value = value?.[k]
    }
    return value || key
  }

  return (
    <I18nContext.Provider value={{ locale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}