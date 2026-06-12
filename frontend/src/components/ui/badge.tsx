"use client"

import * as React from "react"

const Badge = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "destructive" | "outline" }
>(({ className, variant = "default", ...props }, ref) => {
  const variantStyles = {
    default: "bg-blue-600 dark:bg-blue-500 text-white",
    secondary: "bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100",
    destructive: "bg-red-600 dark:bg-red-500 text-white",
    outline: "border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200",
  }

  return (
    <span
      ref={ref}
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${variantStyles[variant]} ${className || ""}`}
      {...props}
    />
  )
})
Badge.displayName = "Badge"

export { Badge }
