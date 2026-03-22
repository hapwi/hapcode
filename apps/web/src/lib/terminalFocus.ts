export function isTerminalFocused(): boolean {
  const activeElement = document.activeElement;
  if (!(activeElement instanceof HTMLElement)) return false;
  if (activeElement.classList.contains("xterm-helper-textarea")) return true;
  // Check for xterm inside any terminal container (drawer or canvas workspace)
  return activeElement.closest(".xterm") !== null;
}
