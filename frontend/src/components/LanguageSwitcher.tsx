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
    <div className="flex rounded-lg border border-gray-300 dark:border-gray-600 overflow-hidden">
      {languages.map((lang) => (
        <button
          key={lang.code}
          onClick={() => switchLocale(lang.code)}
          className={`px-3 py-1 text-sm transition ${
            locale === lang.code
              ? "bg-blue-600 text-white"
              : "bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
          }`}
        >
          {lang.label}
        </button>
      ))}
    </div>
  )
}