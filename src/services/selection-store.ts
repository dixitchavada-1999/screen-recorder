import type { CaptureSource } from '@shared/types'

/**
 * Holds the capture source the user has selected.
 *
 * This lives outside React because the tray menu can start a recording while
 * the Recorder page is not mounted (the user may be on Settings, or the window
 * may be hidden entirely). A module-level store keeps one answer to "what would
 * we record?" no matter what is on screen.
 */
class SelectionStore {
  private selected: CaptureSource | null = null
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): CaptureSource | null => this.selected

  set(source: CaptureSource | null): void {
    if (this.selected?.id === source?.id) return

    this.selected = source
    for (const listener of this.listeners) listener()
  }

  /**
   * Re-resolves the selection against a fresh source list.
   *
   * Window ids change when a window is closed and reopened, so after every
   * refresh the stored source is either revalidated or replaced with a sensible
   * default (the primary screen).
   */
  reconcile(sources: CaptureSource[]): void {
    if (sources.length === 0) {
      this.set(null)
      return
    }

    const stillPresent = this.selected
      ? sources.find((source) => source.id === this.selected?.id)
      : undefined

    if (stillPresent) {
      this.set(stillPresent)
      return
    }

    this.set(sources.find((source) => source.kind === 'screen') ?? sources[0] ?? null)
  }
}

export const selectionStore = new SelectionStore()
