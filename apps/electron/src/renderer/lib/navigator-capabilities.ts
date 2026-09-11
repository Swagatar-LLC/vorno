/**
 * Capability checks shared by desktop sidebar, compact/mobile content, and
 * keyboard navigation. Keeping the conditional navigators here prevents one
 * surface from exposing a route that another intentionally hides.
 */
export interface NavigatorCapabilities {
  pagesEnabled: boolean
  workbenchEnabled: boolean
  artifactsEnabled: boolean
}

export type CapabilityNavigator = 'projects' | 'pages' | 'workbench' | 'artifacts'

/** Pages callers that do not own the other optional-nav settings need only this authority. */
export function isPagesNavigatorAvailable(pagesEnabled: boolean): boolean {
  return pagesEnabled
}

export function isNavigatorAvailable(
  navigator: CapabilityNavigator,
  capabilities: NavigatorCapabilities,
): boolean {
  switch (navigator) {
    case 'projects':
      return true
    case 'pages':
      return capabilities.pagesEnabled
    case 'workbench':
      return capabilities.workbenchEnabled
    case 'artifacts':
      return capabilities.artifactsEnabled
  }
}
