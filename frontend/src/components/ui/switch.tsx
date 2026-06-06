"use client"

import * as React from "react"

export interface SwitchProps {
  checked?: boolean
  onCheckedChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ className = "", checked = false, onCheckedChange, disabled = false, ...props }, ref) => {
    return (
      <button
        type="button"
        role="switch"
        ref={ref}
        disabled={disabled}
        onClick={() => onCheckedChange?.(!checked)}
        className={`
          peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent
          transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
          focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50
          ${checked ? "bg-blue-600" : "bg-gray-200"}
          ${disabled ? "opacity-50 cursor-not-allowed" : ""}
          ${className}
        `}
        aria-checked={checked}
        {...props}
      >
        <span
          className={`
            pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow transform ring-0
            transition ease-in-out duration-200
            ${checked ? "translate-x-5" : "translate-x-0"}
          `}
        />
      </button>
    )
  }
)
Switch.displayName = "Switch"

export { Switch }