import * as React from "react"

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {}

// A card with an onClick is a way to another page, and a <div> with a click
// handler is one for the mouse only: Tab passes it, Enter does nothing, a
// screen reader announces text. Such a card is a link — in the tab order,
// opened by Enter, with a visible focus ring. A key pressed in a control
// inside the card belongs to that control.
const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = "", onClick, onKeyDown, ...props }, ref) => {
    const clickable = typeof onClick === "function"
    return (
      <div
        ref={ref}
        className={`rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm ${
          clickable ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 " : ""
        }${className}`}
        {...(clickable ? { role: "link", tabIndex: 0 } : {})}
        onClick={onClick}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          if (clickable && e.key === "Enter" && e.target === e.currentTarget && !e.defaultPrevented) {
            e.currentTarget.click()
          }
        }}
        {...props}
      />
    )
  }
)
Card.displayName = "Card"

const CardHeader = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = "", ...props }, ref) => (
    <div ref={ref} className={`flex flex-col space-y-1.5 p-6 ${className}`} {...props} />
  )
)
CardHeader.displayName = "CardHeader"

const CardTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className = "", ...props }, ref) => (
    <h3 ref={ref} className={`text-2xl font-semibold leading-none tracking-tight ${className}`} {...props} />
  )
)
CardTitle.displayName = "CardTitle"

const CardContent = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className = "", ...props }, ref) => (
    <div ref={ref} className={`p-6 pt-0 ${className}`} {...props} />
  )
)
CardContent.displayName = "CardContent"

export { Card, CardHeader, CardTitle, CardContent }
