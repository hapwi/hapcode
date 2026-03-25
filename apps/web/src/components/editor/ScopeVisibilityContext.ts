import { createContext, useContext } from "react";

/**
 * Indicates whether the current canvas scope is the active (visible) one.
 *
 * When `false`, components should pause expensive work like timers, polling
 * queries, and animations. The React tree stays mounted (preserving terminal
 * and browser state) but stops burning CPU on things the user can't see.
 *
 * Default is `true` so components rendered outside the canvas (e.g. Sidebar)
 * behave normally.
 */
const ScopeVisibilityContext = createContext<boolean>(true);

export const ScopeVisibilityProvider = ScopeVisibilityContext.Provider;

export function useScopeActive(): boolean {
  return useContext(ScopeVisibilityContext);
}
