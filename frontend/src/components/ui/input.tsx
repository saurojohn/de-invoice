import * as React from "react"

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", type, ...props }, ref) => {
    // Tier 728: a width passed in (w-16, w-28, w-44 …) replaces w-full — both
    // were set, and w-full came later in the stylesheet: the postcode took
    // the whole row in the settings, the Skonto days a full column.
    const width = /(^|\s)w-(?!full\b)\S+/.test(className) ? "" : "w-full" // (max-w-* keeps it)
    return (
      <input
        type={type}
        className={`flex h-10 ${width} rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-gray-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input }
