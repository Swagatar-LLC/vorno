import craftLogo from "@/assets/craft_logo_c.svg"

interface CraftAppIconProps {
  className?: string
  size?: number
}

/**
 * CraftAppIcon - Displays the Vorno logo (colorful vortex-"V" icon)
 */
export function CraftAppIcon({ className, size = 64 }: CraftAppIconProps) {
  return (
    <img
      src={craftLogo}
      alt="Vorno"
      width={size}
      height={size}
      className={className}
    />
  )
}
