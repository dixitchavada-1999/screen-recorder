import { useCallback, useMemo } from 'react'
import type { AppInfo, AppSettings } from '@shared/types'
import type { DeepPartial } from '@shared/api'
import { ShortcutField } from '@/components/ShortcutField'
import { Button } from '@/components/ui/Button'
import { Card, Field } from '@/components/ui/Card'
import { Select, Slider, Toggle, type SelectOption } from '@/components/ui/Controls'
import { useToast } from '@/context/ToastContext'
import { useAudioDevices } from '@/hooks/useAudioDevices'
import { toSerializedError, unwrap } from '@/services/ipc'
import { systemAudioHint } from '@/services/platform'
import { truncatePath } from '@/utils/format'


interface SettingsPageProps {
  settings: AppSettings
  appInfo: AppInfo | null
  disabled: boolean
  onUpdate: (patch: DeepPartial<AppSettings>) => void
  onReset: () => void
}

/** Video, audio and storage configuration, plus environment diagnostics. */
export function SettingsPage({
  settings,
  appInfo,
  disabled,
  onUpdate,
  onReset
}: SettingsPageProps): React.JSX.Element {
  const { microphones, monitors, refresh } = useAudioDevices()
  const { push } = useToast()
  const customFolder = settings.storage.outputFolder
  const defaultFolder = appInfo?.defaultRecordingsDirectory ?? ''
  // Derived from settings rather than `appInfo.recordingsDirectory`, which is
  // read once at startup and would go stale the moment the folder changes.
  const activeFolder = customFolder ?? defaultFolder

  /**
   * Points new recordings at a different folder.
   *
   * Nothing on disk moves. Recordings already saved stay exactly where they
   * were written and remain in the library, because the catalog tracks each one
   * by its own path rather than by the folder currently configured here.
   */
  const applyFolder = useCallback(
    (value: string | null, path: string) => {
      onUpdate({ storage: { outputFolder: value } })
      push({
        tone: 'success',
        title: 'Recordings folder updated',
        description: path || 'Default app folder'
      })
    },
    [onUpdate, push]
  )

  const handleBrowse = useCallback(async () => {
    try {
      const folder = await unwrap(window.api.library.chooseFolder())
      if (!folder || folder === activeFolder) return
      applyFolder(folder, folder)
    } catch (caught) {
      const error = toSerializedError(caught)
      push({
        tone: 'error',
        title: error.message,
        ...(error.hint ? { description: error.hint } : {})
      })
    }
  }, [activeFolder, applyFolder, push])

  const micOptions: Array<SelectOption<string>> = useMemo(
    () => [
      { value: '', label: 'System default' },
      ...microphones.map((device) => ({ value: device.deviceId, label: device.label }))
    ],
    [microphones]
  )

  const monitorOptions: Array<SelectOption<string>> = useMemo(
    () => [
      { value: '', label: monitors.length > 0 ? 'Automatic (first monitor found)' : 'None detected' },
      ...monitors.map((device) => ({ value: device.deviceId, label: device.label }))
    ],
    [monitors]
  )

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------- Audio ------------------------------ */}
      <Card
        title="Audio"
        description="Microphone and system audio are mixed into a single stereo track."
        actions={
          <Button size="sm" variant="ghost" onClick={() => void refresh()}>
            Rescan devices
          </Button>
        }
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-3">
            <Toggle
              label="Record microphone"
              checked={settings.audio.microphoneEnabled}
              onCheckedChange={(microphoneEnabled) =>
                onUpdate({ audio: { microphoneEnabled } })
              }
            />

            <Field label="Microphone device" htmlFor="setting-mic">
              <Select
                id="setting-mic"
                value={settings.audio.microphoneDeviceId ?? ''}
                options={micOptions}
                disabled={!settings.audio.microphoneEnabled}
                onValueChange={(deviceId) =>
                  onUpdate({ audio: { microphoneDeviceId: deviceId || null } })
                }
              />
            </Field>

            <Field label="Microphone level" htmlFor="setting-mic-gain">
              <Slider
                id="setting-mic-gain"
                min={0}
                max={2}
                step={0.05}
                value={settings.audio.microphoneGain}
                disabled={!settings.audio.microphoneEnabled}
                format={(value) => `${Math.round(value * 100)}%`}
                onValueChange={(microphoneGain) => onUpdate({ audio: { microphoneGain } })}
              />
            </Field>
          </div>

          <div className="flex flex-col gap-3">
            <Toggle
              label="Record system audio"
              checked={settings.audio.systemAudioEnabled}
              onCheckedChange={(systemAudioEnabled) =>
                onUpdate({ audio: { systemAudioEnabled } })
              }
            />

            <Field
              label="System audio source"
              htmlFor="setting-loopback"
              hint={systemAudioHint()}
            >
              <Select
                id="setting-loopback"
                value={settings.audio.systemAudioDeviceId ?? ''}
                options={monitorOptions}
                disabled={!settings.audio.systemAudioEnabled}
                onValueChange={(deviceId) =>
                  onUpdate({ audio: { systemAudioDeviceId: deviceId || null } })
                }
              />
            </Field>

            <Field label="System audio level" htmlFor="setting-system-gain">
              <Slider
                id="setting-system-gain"
                min={0}
                max={2}
                step={0.05}
                value={settings.audio.systemAudioGain}
                disabled={!settings.audio.systemAudioEnabled}
                format={(value) => `${Math.round(value * 100)}%`}
                onValueChange={(systemAudioGain) => onUpdate({ audio: { systemAudioGain } })}
              />
            </Field>
          </div>
        </div>

      </Card>

      {/* ----------------------------- Shortcuts ---------------------------- */}
      <Card
        title="Shortcuts"
        description="Keys this app answers to, wherever you are on the machine."
      >
        <ShortcutField
          value={settings.shortcuts.toggleRecording}
          onChange={(toggleRecording) => onUpdate({ shortcuts: { toggleRecording } })}
        />
      </Card>

      {/* ------------------------------ Storage ----------------------------- */}
      <Card
        title="Storage"
        description="Where new recordings are written. The Recordings tab lists them wherever they live."
        actions={
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void unwrap(window.api.library.openFolder())}
          >
            Open folder
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <Field
            label="Recordings folder"
            hint={
              customFolder
                ? 'New recordings are saved here. Nothing already recorded is moved — earlier captures stay where they are and stay on the Recordings tab.'
                : 'Currently the app-managed folder on the system drive. Browse to save new recordings elsewhere; you can change this any time.'
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <p
                className="selectable min-w-0 flex-1 truncate rounded-xl border border-hairline bg-surface px-3 py-2.5 font-mono text-xs text-ink"
                title={activeFolder || 'Default app folder'}
              >
                {activeFolder ? truncatePath(activeFolder, 54) : 'Default app folder'}
              </p>

              <Button
                size="md"
                variant="secondary"
                disabled={disabled}
                onClick={() => void handleBrowse()}
                icon={<FolderIcon />}
              >
                Browse…
              </Button>

              {customFolder && (
                <Button
                  size="md"
                  variant="ghost"
                  disabled={disabled || !defaultFolder}
                  onClick={() => applyFolder(null, defaultFolder)}
                >
                  Use default
                </Button>
              )}
            </div>
          </Field>

          <Field
            label="Filename pattern"
            htmlFor="setting-pattern"
            hint="Tokens: {date}, {time}, {timestamp}. The .mp4 extension is added for you."
          >
            <input
              id="setting-pattern"
              type="text"
              spellCheck={false}
              value={settings.storage.filenamePattern}
              onChange={(event) =>
                onUpdate({ storage: { filenamePattern: event.target.value } })
              }
              className="selectable h-10 w-full rounded-xl border border-hairline bg-surface px-3 font-mono text-sm text-ink transition-colors hover:border-faint"
            />
          </Field>

        </div>
      </Card>

      {/* ---------------------------- Diagnostics --------------------------- */}
      <Card
        title="About"
        actions={
          <Button size="sm" variant="danger" onClick={onReset} disabled={disabled}>
            Reset to defaults
          </Button>
        }
      >
        <dl className="grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
          <Detail label="Application" value={appInfo ? `v${appInfo.version}` : '—'} />
          <Detail label="Platform" value={appInfo?.platform ?? '—'} />
          <Detail label="Electron" value={appInfo?.electronVersion ?? '—'} />
          <Detail label="Chromium" value={appInfo?.chromeVersion ?? '—'} />
          <Detail
            label="FFmpeg"
            value={appInfo?.ffmpegVersion ?? (appInfo ? 'Not found' : '—')}
            tone={appInfo && !appInfo.ffmpegPath ? 'error' : 'default'}
          />
          <Detail
            label="Logs"
            value={appInfo ? truncatePath(appInfo.logDirectory, 38) : '—'}
            onClick={
              appInfo
                ? () => void unwrap(window.api.shell.openPath(appInfo.logDirectory))
                : undefined
            }
          />
        </dl>

        {appInfo && !appInfo.ffmpegPath && (
          <p className="mt-3 rounded-lg border border-record/40 bg-record/10 px-3 py-2 text-xs text-record-strong">
            No FFmpeg binary was found, so recordings cannot be converted to MP4.
            {appInfo.platform === 'linux'
              ? ' Install it with: sudo apt install ffmpeg'
              : ' Reinstall the application to restore the bundled binary.'}
          </p>
        )}
      </Card>

    </div>
  )
}

const FolderIcon = (): React.JSX.Element => (
  <svg
    aria-hidden="true"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    className="size-4"
  >
    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17V7.5z" />
  </svg>
)

function Detail({
  label,
  value,
  tone = 'default',
  onClick
}: {
  label: string
  value: string
  tone?: 'default' | 'error'
  onClick?: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline/60 py-1.5">
      <dt className="shrink-0 text-faint">{label}</dt>
      <dd
        className={
          tone === 'error' ? 'truncate text-record-strong' : 'selectable truncate text-muted'
        }
        title={value}
      >
        {onClick ? (
          <button type="button" onClick={onClick} className="truncate hover:text-ink hover:underline">
            {value}
          </button>
        ) : (
          value
        )}
      </dd>
    </div>
  )
}
