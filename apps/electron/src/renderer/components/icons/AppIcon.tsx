import appLogo from "@/assets/logo_mark.svg"

interface AppIconProps {
  className?: string
  size?: number
}

/**
 * AppIcon - Displays the Vorno logo (colorful vortex-"V" icon)
 */
export function AppIcon({ className, size = 64 }: AppIconProps) {
  return (
    <img
      src={appLogo}
      alt="Vorno"
      width={size}
      height={size}
      className={className}
    />
  )
}
