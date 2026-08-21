import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { DeepPartial } from '@shared/api'
import type { AppSettings, RecordingState } from '@shared/types'
import { AuthDialog } from '@/components/AuthDialog'
import { ToastStack } from '@/components/ToastStack'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { AuthProvider, useAuth } from '@/context/AuthContext'
import { SettingsProvider, useSettings } from '@/context/SettingsContext'
import { ToastProvider, useToast } from '@/context/ToastContext'
import { useAppInfo } from '@/hooks/useAppInfo'
import { useRecorder } from '@/hooks/useRecorder'
import { useTransport } from '@/hooks/useTransport'
import { AccountPage } from '@/pages/AccountPage'
import { RecorderPage } from '@/pages/RecorderPage'
import { RecordingsPage } from '@/pages/RecordingsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { log } from '@/services/ipc'
import { setPlatform } from '@/services/platform'
import { recordingController } from '@/services/recording-controller'
import { selectionStore } from '@/services/selection-store'
import { cn } from '@/utils/cn'

/** `account` only exists while somebody is signed in. */
type Route = 'recorder' | 'recordings' | 'settings' | 'account'

/**
 * Temporarily hides the account control in the top bar — the "Log in" button
 * when signed out, and the name chip when signed in.
 *
 * Nothing else about accounts is switched off: an existing session stays signed
 * in, the schedule keeps syncing and reminders keep firing. Only the way in is
 * gone, so while this is `false` the account area — Call Manager and Calendars
 * included — cannot be reached. Set it back to `true` to restore the control.
 */
const SHOW_ACCOUNT_CONTROL = true

export default function App(): React.JSX.Element {
  return (
    <ToastProvider>
      <AuthProvider>
        <SettingsProvider>
          <AppShell />
          <ToastStack />
        </SettingsProvider>
      </AuthProvider>
    </ToastProvider>
  )
}

/**
 * Application shell: navigation, global event wiring and the loading gate.
 *
 * Split from `App` so it can consume the providers declared above it.
 */
function AppShell(): React.JSX.Element {
  const { settings, loading, updateSettings, resetSettings } = useSettings()
  const appInfo = useAppInfo()
  const snapshot = useRecorder()
  const transport = useTransport()
  const { user } = useAuth()
  const { push } = useToast()

  const [route, setRoute] = useState<Route>('recorder')
  /** Recording the library page should open when navigating in from a tile. */
  const [pendingPlayId, setPendingPlayId] = useState<string | null>(null)
  /** Whether the sign-in dialog is open. */
  const [authOpen, setAuthOpen] = useState(false)

  const selectedSource = useSyncExternalStore(
    selectionStore.subscribe,
    selectionStore.getSnapshot
  )

  const isLive = snapshot.state === 'recording' || snapshot.state === 'paused'
  const isBusy = snapshot.state !== 'idle' && snapshot.state !== 'error'

  /*
   * Platform-dependent wording.
   *
   * The renderer guesses from the user agent so the first paint is already
   * right; this replaces the guess with the real `process.platform` as soon as
   * the main process answers. Capturing system audio differs on all three
   * platforms, and advice for the wrong one is worse than none.
   */
  useEffect(() => {
    if (!appInfo) return
    setPlatform(appInfo.platform)

    // macOS only asks for the microphone once, ever. Asking here means the
    // prompt arrives at launch, with the app in front of the user, rather than
    // in the middle of starting their first recording.
    if (appInfo.platform === 'darwin') {
      void window.api.permissions.requestMicrophone()
    }
  }, [appInfo])

  /*
   * Tray integration.
   *
   * Both effects live in the shell rather than on the Recorder page, because
   * the tray must keep working while the user is on Settings or the window is
   * hidden entirely — at which point that page is not mounted.
   */
  useEffect(() => {
    window.api.tray.syncState({
      state: snapshot.state,
      elapsedMs: snapshot.elapsedMs,
      canStart: Boolean(selectedSource) && !isBusy
    })
  }, [snapshot.state, snapshot.elapsedMs, selectedSource, isBusy])

  useEffect(() => {
    return window.api.tray.onCommand((command) => {
      log.info('app', 'Tray command received', { command })

      switch (command) {
        case 'start':
          void transport.start()
          break
        case 'stop':
          void transport.stop()
          break
        case 'pause':
          transport.pause()
          break
        case 'resume':
          transport.resume()
          break
      }
    })
  }, [transport])

  /* Encode progress events from the main process. */
  useEffect(() => {
    return window.api.recording.onProgress((progress) => {
      recordingController.handleProgress(progress)
    })
  }, [])

  // Signing out (from here or from anywhere else) must not leave the account
  // area on screen with nothing behind it.
  useEffect(() => {
    if (!user) setRoute((current) => (current === 'account' ? 'recorder' : current))
  }, [user])

  // Coming back from the tray lands on the Recorder. The renderer survives being
  // hidden, so without this the app would reopen on whatever page it was left on
  // — the tray is the way to the recorder, and that is what it should show.
  useEffect(() => {
    return window.api.window.onShown(() => setRoute('recorder'))
  }, [])

  /*
   * Call reminders.
   *
   * The main process owns the timers and raises the OS notification; this is
   * the in-app half, which is what the user sees when the window is already in
   * front of them. Lives in the shell so it works from any page.
   */
  useEffect(() => {
    return window.api.calls.onReminder((reminder) => {
      const at = new Date(reminder.startsAt).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      })

      push(
        {
          tone: reminder.leadMinutes <= 5 ? 'warning' : 'info',
          title: reminder.title,
          description:
            reminder.leadMinutes === 0
              ? `Starting now · ${at}`
              : `Starts in ${reminder.leadMinutes} minute${reminder.leadMinutes === 1 ? '' : 's'} · ${at}`
        },
        // Held on screen longer than a normal toast: missing it is the whole
        // failure this feature exists to prevent.
        30_000
      )
    })
  }, [push])

  /* The main process asks us to stop when the app is quitting mid-recording. */
  useEffect(() => {
    return window.api.onStopRequested(() => {
      log.warn('app', 'Stop requested by the main process')
      void recordingController.stop()
    })
  }, [])

  /* Warn before closing the window while a recording is live. */
  useEffect(() => {
    if (!isLive) return

    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
    }

    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isLive])

  /* Keyboard shortcuts for the primary transport controls. */
  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable

      if (typing || !event.ctrlKey || !event.shiftKey) return

      // Ctrl+Shift+R toggles recording, Ctrl+Shift+P pauses or resumes.
      if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        if (isLive) void transport.stop()
        else if (!isBusy) void transport.start()
      } else if (event.key.toLowerCase() === 'p') {
        event.preventDefault()
        if (snapshot.state === 'recording') transport.pause()
        else if (snapshot.state === 'paused') transport.resume()
      }
    }

    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isLive, isBusy, snapshot.state, transport])

  const handleUpdate = useCallback(
    (patch: DeepPartial<AppSettings>) => {
      void updateSettings(patch)
    },
    [updateSettings]
  )

  if (loading || !settings) return <LoadingScreen />

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <Header
        route={route}
        onNavigate={setRoute}
        state={snapshot.state}
        canStart={Boolean(selectedSource) && !isBusy}
        onStart={() => void transport.start()}
        onStop={() => void transport.stop()}
        onPause={transport.pause}
        onResume={transport.resume}
        accountRoute={route === 'account'}
        onSignIn={() => setAuthOpen(true)}
        onOpenAccount={() => setRoute('account')}
      />

      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />

      <main className="flex-1 overflow-y-auto px-6 py-5">
        {/*
          Grows with the window instead of sitting in a fixed column: maximised
          or full screen, the calendar and the recordings list get the width
          that was the point of enlarging the window.

          The cap only bites on very wide monitors, where an unbroken run of
          text across 3000-odd pixels is harder to read, not easier.
        */}
        <div className="mx-auto w-full max-w-[112rem]">
          {route === 'recorder' && (
            <RecorderPage
              settings={settings}
              transport={transport}
              supportsNativeLoopback={appInfo?.supportsNativeLoopback ?? false}
              onUpdateSettings={handleUpdate}
              onViewAll={() => {
                setPendingPlayId(null)
                setRoute('recordings')
              }}
              onPlayRecording={(recordingId) => {
                setPendingPlayId(recordingId)
                setRoute('recordings')
              }}
            />
          )}

          {route === 'recordings' && <RecordingsPage initialRecordingId={pendingPlayId} />}

          {route === 'account' && <AccountPage onSignedOut={() => setRoute('recorder')} />}

          {route === 'settings' && (
            <SettingsPage
              settings={settings}
              appInfo={appInfo}
              disabled={isBusy}
              onUpdate={handleUpdate}
              onReset={() => void resetSettings()}
            />
          )}
        </div>
      </main>
    </div>
  )
}

/* -------------------------------------------------------------------------- */

interface HeaderProps {
  route: Route
  onNavigate: (route: Route) => void
  state: RecordingState
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
  /** True while the account area is the page on screen. */
  accountRoute: boolean
  /** Opens the sign-in dialog. */
  onSignIn: () => void
  /** Opens the account area. */
  onOpenAccount: () => void
}

function Header({
  route,
  onNavigate,
  state,
  canStart,
  onStart,
  onStop,
  onPause,
  onResume,
  accountRoute,
  onSignIn,
  onOpenAccount
}: HeaderProps): React.JSX.Element {
  const recording = state === 'recording'
  const paused = state === 'paused'

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-hairline bg-canvas-elevated/60 px-6 py-3">
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'grid size-9 place-items-center rounded-xl',
            recording ? 'bg-record/15 text-record-strong' : 'bg-accent/15 text-accent-strong'
          )}
        >
          <RecordIcon />
        </span>

        <div>
          <h1 className="text-sm font-semibold leading-tight text-ink">Screen Recorder</h1>
          <p className="text-[11px] leading-tight text-faint">
            {recording ? 'Recording in progress' : paused ? 'Paused' : 'Ready'}
          </p>
        </div>
      </div>

      {/*
        Quick transport, available from every page and while the Recorder page
        is not even mounted. It drives the same `useTransport` instance as the
        hero panel and the tray, so the three can never disagree.
      */}
      <QuickTransport
        state={state}
        canStart={canStart}
        onStart={onStart}
        onStop={onStop}
        onPause={onPause}
        onResume={onResume}
      />

      <div className="flex items-center gap-2">
        <nav className="flex items-center gap-1 rounded-xl border border-hairline bg-surface p-0.5">
          <NavButton active={route === 'recorder'} onClick={() => onNavigate('recorder')}>
            Recorder
          </NavButton>
          <NavButton active={route === 'recordings'} onClick={() => onNavigate('recordings')}>
            Recordings
          </NavButton>
          <NavButton active={route === 'settings'} onClick={() => onNavigate('settings')}>
            Settings
          </NavButton>
        </nav>

        {/* There is no taskbar button, so hiding needs an explicit control. */}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => window.api.window.hide()}
          title="Hide to the system tray — recording continues"
        >
          Hide to tray
        </Button>

        <HomeButton
          active={accountRoute}
          onSignIn={onSignIn}
          onOpenAccount={onOpenAccount}
        />
      </div>
    </header>
  )
}

/**
 * The rightmost control in the top bar: one icon, in every state.
 *
 * What it means does not change with the session — it is the way to your own
 * account — so what it looks like does not change either. Where it lands does:
 * the dashboard when there is a session, the sign-in dialog when there is not.
 * That is a question the control can answer on the person's behalf rather than
 * making them read the answer off a label before they press anything.
 *
 * Unlike the name chip it replaces, this is on screen while the stored session
 * is still being checked. That check took the control off the bar for a moment
 * at every launch, to stop it flipping from "Log in" into somebody's name — an
 * icon that is identical either way has nothing to flip into. It is only
 * disabled for that moment, because until the check comes back there is no
 * answer yet about where pressing it should go.
 */
function HomeButton({
  active,
  onSignIn,
  onOpenAccount
}: {
  active: boolean
  onSignIn: () => void
  onOpenAccount: () => void
}): React.JSX.Element | null {
  const { user, loading } = useAuth()

  if (!SHOW_ACCOUNT_CONTROL) return null

  const label = user ? 'Your dashboard' : 'Sign in'

  return (
    <button
      type="button"
      disabled={loading}
      onClick={user ? onOpenAccount : onSignIn}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      title={user ? `${label} — signed in as ${user.email}` : label}
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-lg border transition-colors',
        'disabled:opacity-50',
        active
          ? 'border-accent/50 bg-accent/15 text-accent-strong'
          : 'border-hairline bg-surface text-ink hover:border-faint'
      )}
    >
      <HomeIcon />
    </button>
  )
}

/**
 * Icon-only start / pause / stop cluster centred in the top bar.
 *
 * All three stay on screen at all times and enable themselves according to the
 * recorder state — the shape of the control never shifts under the pointer, so
 * the button you reach for is the button you press.
 */
function QuickTransport({
  state,
  canStart,
  onStart,
  onStop,
  onPause,
  onResume
}: {
  state: RecordingState
  canStart: boolean
  onStart: () => void
  onStop: () => void
  onPause: () => void
  onResume: () => void
}): React.JSX.Element {
  const isLive = state === 'recording' || state === 'paused'
  const paused = state === 'paused'

  return (
    <div className="flex flex-1 items-center justify-center gap-2">
      <TransportButton
        tone="record"
        label={
          canStart
            ? 'Start recording (Ctrl+Shift+R)'
            : 'Choose a screen or window on the Recorder tab first'
        }
        disabled={!canStart || isLive}
        onClick={onStart}
      >
        <span aria-hidden="true" className="size-3 rounded-full bg-current" />
      </TransportButton>

      <TransportButton
        tone="neutral"
        label={paused ? 'Resume recording (Ctrl+Shift+P)' : 'Pause recording (Ctrl+Shift+P)'}
        disabled={!isLive}
        onClick={paused ? onResume : onPause}
      >
        {paused ? <PlayGlyph /> : <PauseGlyph />}
      </TransportButton>

      <TransportButton
        tone="neutral"
        label="Stop and save (Ctrl+Shift+R)"
        disabled={!isLive}
        onClick={onStop}
      >
        <span aria-hidden="true" className="size-2.5 rounded-[2px] bg-current" />
      </TransportButton>
    </div>
  )
}

/**
 * Round icon button used by the top bar transport.
 *
 * The icons carry no words, and two of the three are usually disabled, so the
 * hover label is the only thing that says what they do — hence `Tooltip`
 * rather than a `title`, which a disabled button never shows.
 */
function TransportButton({
  tone,
  label,
  disabled,
  onClick,
  children
}: {
  tone: 'record' | 'neutral'
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          'grid size-9 place-items-center rounded-full border transition-colors',
          'disabled:cursor-not-allowed disabled:opacity-35',
          tone === 'record'
            ? 'border-transparent bg-record text-white enabled:hover:bg-record-strong'
            : 'border-hairline bg-surface text-ink enabled:hover:border-faint enabled:hover:text-record-strong'
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

function NavButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
        active ? 'bg-accent text-white' : 'text-muted hover:text-ink'
      )}
    >
      {children}
    </button>
  )
}

function LoadingScreen(): React.JSX.Element {
  return (
    <div className="grid h-full place-items-center">
      <div className="flex flex-col items-center gap-3">
        <Button variant="ghost" loading disabled aria-label="Loading" />
        <p className="text-xs text-faint">Starting Screen Recorder…</p>
      </div>
    </div>
  )
}

const PauseGlyph = (): React.JSX.Element => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
    <path d="M6 4h3v12H6V4zm5 0h3v12h-3V4z" />
  </svg>
)

const PlayGlyph = (): React.JSX.Element => (
  <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className="size-3.5">
    <path d="M6 4l10 6-10 6V4z" />
  </svg>
)

const HomeIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.7"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-4"
  >
    <path d="M4 10.3 12 4l8 6.3V19a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 19v-8.7Z" />
    <path d="M9.7 20.5V15h4.6v5.5" />
  </svg>
)

const RecordIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    className="size-5"
  >
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
  </svg>
)
