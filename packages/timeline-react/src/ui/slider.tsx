"use client"

import * as React from "react"
import { cn } from "./cn"

interface SliderProps {
  value?: number[]
  defaultValue?: number[]
  max?: number
  min?: number
  step?: number
  disabled?: boolean
  className?: string
  onValueChange?: (value: number[]) => void
  onValueCommit?: (value: number[]) => void
}

function Slider({
  className,
  value,
  defaultValue,
  max = 100,
  min = 0,
  step = 1,
  disabled = false,
  onValueChange,
  onValueCommit,
}: SliderProps) {
  const current = value?.[0] ?? defaultValue?.[0] ?? 0
  const pct = ((current - min) / (max - min)) * 100

  return (
    <div
      data-slot="slider"
      className={cn("relative flex w-full items-center select-none", disabled && "opacity-50", className)}
    >
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={current}
        disabled={disabled}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          onValueChange?.([v])
        }}
        onMouseUp={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value)
          onValueCommit?.([v])
        }}
        onTouchEnd={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value)
          onValueCommit?.([v])
        }}
        onKeyUp={(e) => {
          const v = parseFloat((e.target as HTMLInputElement).value)
          onValueCommit?.([v])
        }}
        className="on-slider-input w-full h-6 cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed"
        style={
          {
            "--slider-pct": `${pct}%`,
          } as React.CSSProperties
        }
      />
    </div>
  )
}

export { Slider }
