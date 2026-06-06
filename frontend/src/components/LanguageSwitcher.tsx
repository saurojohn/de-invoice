"use client"

import { useI18n } from "./useI18n"

const languages = [
  { code: "de", label: "DE" },
  { code: "zh", label: "中文" },
  { code: "en", label: "EN" },
]

export default function LanguageSwitcher() {
  const { locale, switchLocale } = useI18n()

  return (
    <div className="flex rounded-lg border overflow-hidden">
      {languages.map((lang) => (
        <button
          key={lang.code}
          onClick={() => switchLocale(lang.code)}
          className={`px-3 py-1 text-sm transition ${
            locale === lang.code
              ? "bg-blue-600 text-white"
              : "bg-white text-gray-600 hover:bg-gray-100"
          }`}
        >
          {lang.label}
        </button>
      ))}
    </div>
  )
}