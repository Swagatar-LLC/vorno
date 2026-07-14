/**
 * SettingsNumberInput
 *
 * Number input for settings rows that commits on blur/Enter instead of on
 * every keystroke.
 *
 * A controlled `<input type="number">` whose onChange parses + persists
 * immediately can never be retyped: clearing the field yields NaN, the
 * fallback snaps the value back, and every intermediate keystroke (e.g. "3",
 * "39", "399" while typing 3999) gets persisted as a real config value. This
 * component keeps the in-progress text in local state while focused and only
 * parses, clamps to [min, max], and calls onCommit when the user leaves the
 * field or presses Enter. Invalid/empty input reverts to the last committed
 * value. Escape cancels the edit.
 */

import * as React from 'react'
import { cn } from '@/lib/utils'

export interface SettingsNumberInputProps {
  /** Current committed value */
  value: number
  /** Called with the parsed, clamped value on blur/Enter (only if changed) */
  onCommit: (value: number) => void
  /** Minimum allowed value (clamped, not rejected) */
  min: number
  /** Maximum allowed value (clamped, not rejected) */
  max: number
  /** Disabled state */
  disabled?: boolean
  /** Additional className (defaults match the settings-row control styling) */
  className?: string
  /** Accessible label */
  'aria-label'?: string
}

export function SettingsNumberInput({
  value,
  onCommit,
  min,
  max,
  disabled,
  className,
  'aria-label': ariaLabel,
}: SettingsNumberInputProps) {
  const [text, setText] = React.useState(String(value))
  const [editing, setEditing] = React.useState(false)

  // Reflect external value changes while the user isn't mid-edit.
  React.useEffect(() => {
    if (!editing) setText(String(value))
  }, [value, editing])

  const commit = () => {
    setEditing(false)
    const parsed = parseInt(text, 10)
    if (Number.isNaN(parsed)) {
      setText(String(value)) // revert invalid/empty input
      return
    }
    const clamped = Math.min(max, Math.max(min, parsed))
    setText(String(clamped))
    if (clamped !== value) onCommit(clamped)
  }

  const cancel = () => {
    setEditing(false)
    setText(String(value))
  }

  return (
    <input
      type="number"
      value={text}
      aria-label={ariaLabel}
      onFocus={() => setEditing(true)}
      onChange={e => {
        setEditing(true) // typing after Escape re-enters edit mode
        setText(e.target.value)
      }}
      onBlur={commit}
      onKeyDown={e => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') cancel()
      }}
      className={cn('bg-muted rounded-md px-2 py-1 text-sm w-20 text-right', className)}
      min={min}
      max={max}
      disabled={disabled}
    />
  )
}
