import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppSettings, RecordingEntry } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { AudioPanel } from '@/components/AudioPanel'
import { NoteDialog } from '@/components/NoteDialog'
import { PermissionBanner } from '@/components/PermissionBanner'
import { RecentRecordings } from '@/components/RecentRecordings'
import { RecoveryBanner } from '@/components/RecoveryBanner'
import { StatusPanel } from '@/components/StatusPanel'
import { useToast } from '@/context/ToastContext'
import { useLibrary } from '@/hooks/useLibrary'
import { usePermissions } from '@/hooks/usePermissions'
import { useRecorder } from '@/hooks/useRecorder'
import { useRecovery } from '@/hooks/useRecovery'
import { useSources } from '@/hooks/useSources'
import type { Transport } from '@/hooks/useTransport'
import { toSerializedError } from '@/services/ipc'
import { recordingController } from '@/services/recording-controller'
import { selectionStore } from '@/services/selection-store'
import { formatTimestamp } from '@/utils/format'

interface RecorderPageProps {
  settings: AppSettings
  transport: Transport
  /** Windows captures system audio through desktop loopback; Linux does not. */
  supportsNativeLoopback: boolean
  onUpdateSettings: (patch: DeepPartial<AppSettings>) => void
  /** Navigates to the full recordings library. */
  onViewAll: () => void
  /** Opens a recording on the library page. */
  onPlayRecording: (recordingId: string) => void
}

/**
 * The main screen: choose a source, start and stop, and see recent captures.
 *
 * Recording state lives in `recordingController` and the chosen source in
 * `selectionStore`, both outside React, so the tray can drive a recording while
 * this page is unmounted.
 */
export function RecorderPage({
  settings,
  transport,
  supportsNativeLoopback,
  onUpdateSettings,
  onViewAll,
  onPlayRecording
}: RecorderPageProps): React.JSX.Element {
  const snapshot = useRecorder()
  const { sources, error: sourcesError, refresh: refreshSources } = useSources()
  const library = useLibrary()
  const recovery = useRecovery()
  const permissions = usePermissions()
  const { push } = useToast()

  const selectedSource = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot
  )

  /** Recording whose note is being viewed or written, plus the dialog mode. */
  const [noteTarget, setNoteTarget] = useState<{
    recordingId: string
    note: string
    subtitle: string
    variant: 'edit' | 'capture'
  } | null>(null)

  const isLive = snapshot.state === 'recording' || snapshot.state === 'paused'
  const isBusy = snapshot.state !== 'idle' && snapshot.state !== 'error'

  // Revalidate the selection whenever the source list is rebuilt; window ids
  // change when a window is closed and reopened.
  useEffect(() => {
    if (!isLive) selectionStore.reconcile(sources)
  }, [sources, isLive])

  // Surface recorder failures as toasts rather than silent state.
  useEffect(() => {
    if (snapshot.state !== 'error' || !snapshot.error) return

    push({
      tone: 'error',
      title: snapshot.error.message,
      ...(snapshot.error.hint ? { description: snapshot.error.hint } : {})
    })
    recordingController.clearError()
  }, [snapshot.state, snapshot.error, push])

  /*
   * A source list that could not be read.
   *
   * Without this the picker would simply be empty, which reads as "this machine
   * has no screens" rather than as the actual cause — a missing portal package
   * on Linux, a revoked permission on macOS. The message carries the fix.
   */
  useEffect(() => {
    if (!sourcesError) return

    push({
      tone: 'error',
      title: sourcesError.message,
      ...(sourcesError.hint ? { description: sourcesError.hint } : {})
    })
  }, [sourcesError, push])

  // Keep gain changes applied to a recording that is already running.
  useEffect(() => {
    if (isLive) recordingController.applyGains(settings)
  }, [isLive, settings])

  /* ------------------------------- Actions ------------------------------- */

  /**
   * Picks up a finished recording and offers to annotate it.
   *
   * Keyed on the controller's result rather than on the Stop button, so a
   * recording ended from the top bar, the tray or a keyboard shortcut lands
   * here too. The ref starts at whatever is already on the snapshot, so
   * returning to this page does not re-prompt for an earlier capture.
   */
  const { lastResult } = snapshot
  const promptedFor = useRef(lastResult)
  const refreshLibrary = library.refresh

  useEffect(() => {
    if (!lastResult || promptedFor.current === lastResult) return
    promptedFor.current = lastResult

    void refreshLibrary()
    setNoteTarget({
      recordingId: lastResult.recordingId,
      note: '',
      subtitle: formatTimestamp(Date.now()),
      variant: 'capture'
    })
  }, [lastResult, refreshLibrary])

  const handleOpenNote = useCallback((entry: RecordingEntry) => {
    setNoteTarget({
      recordingId: entry.id,
      note: entry.note,
      subtitle: formatTimestamp(entry.createdAt),
      variant: 'edit'
    })
  }, [])

  const handleRestore = useCallback(
    async (sessionId: string) => {
      try {
        const result = await recovery.restore(sessionId)
        if (result) {
          await library.refresh()
          push({
            tone: 'success',
            title: 'Recording recovered',
            description: result.outputPath
          })
        }
      } catch (caught) {
        push({
          tone: 'error',
          title: 'Recovery failed',
          description: toSerializedError(caught).message
        })
      }
    },
    [recovery, library, push]
  )

  /* -------------------------------- Render ------------------------------- */

  return (
    <div className="flex flex-col gap-4">
      <PermissionBanner
        permissions={permissions.permissions}
        microphoneWanted={settings.audio.microphoneEnabled}
        trackingEnabled={settings.tracking.enabled}
        onOpenSettings={(kind) => void permissions.openSettings(kind)}
        onRecheck={() => {
          void permissions.refresh()
          void refreshSources()
        }}
      />

      <RecoveryBanner
        orphans={recovery.orphans}
        busySessionId={recovery.busySessionId}
        onRestore={(sessionId) => void handleRestore(sessionId)}
        onDiscard={(sessionId) => void recovery.discard(sessionId)}
      />

      <StatusPanel
        snapshot={snapshot}
        canStart={Boolean(selectedSource) && !isBusy}
        onStart={() => void transport.start()}
        onStop={() => void transport.stop()}
        onPause={transport.pause}
        onResume={transport.resume}
        onCancel={() => void transport.cancel()}
        onViewAll={onViewAll}
        sources={sources}
        selectedSourceId={selectedSource?.id ?? null}
        onSelectSource={(id) => {
          const match = sources.find((source) => source.id === id)
          if (match) selectionStore.set(match)
          else void refreshSources()
        }}
      />

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        <RecentRecordings
          recordings={library.recordings}
          loading={library.loading}
          onPlay={(entry) => onPlayRecording(entry.id)}
          onOpenNote={handleOpenNote}
          onViewAll={onViewAll}
          onRefresh={() => void library.refresh()}
        />

        <AudioPanel
          settings={settings}
          status={snapshot.audio}
          live={isLive}
          selectedSource={selectedSource}
          supportsNativeLoopback={supportsNativeLoopback}
          onUpdate={onUpdateSettings}
        />
      </div>

      <NoteDialog
        open={noteTarget !== null}
        recordingId={noteTarget?.recordingId ?? null}
        initialNote={noteTarget?.note ?? ''}
        subtitle={noteTarget?.subtitle ?? ''}
        variant={noteTarget?.variant ?? 'edit'}
        onClose={() => setNoteTarget(null)}
        onSaved={() => {
          void library.refresh()
          push({ tone: 'success', title: 'Note saved' })
        }}
      />
    </div>
  )
}
