/**
 * Shared domain types.
 *
 * This module is imported by the main process, the preload bridge and the
 * renderer. It must stay free of any Node.js or DOM specific imports so that
 * all three bundles can consume it.
 */

/* -------------------------------------------------------------------------- */
/*                                  Settings                                  */
/* -------------------------------------------------------------------------- */

export type ResolutionPreset = 'native' | '720p' | '1080p' | '1440p' | '2160p'
export type FpsPreset = 24 | 30 | 60
export type QualityPreset = 'low' | 'balanced' | 'high' | 'ultra'

export interface VideoSettings {
  /** Target output resolution. `native` keeps the captured source size. */
  resolution: ResolutionPreset
  /** Target capture/output frame rate. */
  fps: FpsPreset
  /** Encoder quality tier — drives CRF and bitrate ceilings. */
  quality: QualityPreset
  /**
   * Attempt a GPU encoder (NVENC / QSV / AMF / VAAPI) before falling back to
   * libx264. Lowers CPU usage substantially on supported machines.
   */
  hardwareAcceleration: boolean
  /** Draw the mouse cursor into the captured frames. */
  captureCursor: boolean
}

export interface AudioSettings {
  microphoneEnabled: boolean
  /** `null` means "system default input device". */
  microphoneDeviceId: string | null
  /** Linear gain multiplier applied to the microphone, 0.0 – 2.0. */
  microphoneGain: number

  systemAudioEnabled: boolean
  /**
   * Explicit loopback device id. Only meaningful on Linux, where system audio
   * is captured through a PulseAudio/PipeWire `.monitor` source rather than
   * through Chromium's desktop loopback.
   */
  systemAudioDeviceId: string | null
  /** Linear gain multiplier applied to system audio, 0.0 – 2.0. */
  systemAudioGain: number
}

export interface StorageSettings {
  /**
   * Filename template. Supported tokens: `{date}`, `{time}`, `{timestamp}`.
   * The `.mp4` extension is appended automatically.
   */
  filenamePattern: string
  /**
   * Absolute folder *new* recordings are written to, or `null` for the
   * app-managed default inside `userData`. Pointing it at another drive is the
   * supported way to keep captures off a full system disk.
   *
   * Changing it never moves or hides anything: each recording is catalogued by
   * its own path, so earlier captures stay where they were written and stay in
   * the library.
   */
  outputFolder: string | null
  /** Keep the intermediate WebM file next to the MP4 instead of deleting it. */
  keepIntermediateFile: boolean
}

/**
 * Reserved configuration for the roadmap features listed in the README.
 * The fields are persisted and type-checked today so that enabling a feature
 * later is an additive change rather than a settings migration.
 */
export interface ExperimentalSettings {
  webcamOverlay: {
    enabled: false
    deviceId: string | null
    position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
    size: number
  }
  cursorHighlight: { enabled: false; color: string; radius: number }
  clickEffects: { enabled: false }
  noiseSuppression: boolean
}

/**
 * When and how the Call Manager warns about an upcoming call.
 *
 * Stored on the machine rather than with the account: a reminder is something
 * *this* computer pops up, and it has to keep working with no network. The
 * schedule itself stays in Supabase and follows the account.
 */
export interface NotificationSettings {
  /** Master switch. Off means no reminders of any kind. */
  enabled: boolean
  /**
   * Minutes of warning. One reminder fires per entry, so `[30, 5]` warns twice.
   * An empty list means no lead-time reminders; `0` fires at the start time.
   */
  leadMinutes: number[]
  /** Desktop notification through the OS, visible with the window hidden. */
  systemNotifications: boolean
  /** In-app toast. Only useful while the window is open. */
  inAppNotifications: boolean
}

/* -------------------------------------------------------------------------- */
/*                              Activity tracking                             */
/* -------------------------------------------------------------------------- */

/**
 * Periodic activity and screenshot capture.
 *
 * Built to be visible, not silent. The switch is an administrator's, but while
 * it is on the tray and the window say so, and the My activity page states what
 * is captured, how often and where it goes — to anybody, at any time, without
 * asking. A tracker the person being tracked cannot see is not something this
 * app will be.
 */
export interface TrackingSettings {
  /**
   * Master switch, set by an administrator.
   *
   * Off means nothing is sampled and no screenshot is taken. The person at the
   * machine can see the state and everything behind it, but does not set it —
   * this is an organisation's policy on an organisation's machine.
   */
  enabled: boolean
  /**
   * Minutes between screenshots.
   *
   * Capture runs for as long as the machine is powered on, idle included — an
   * unattended screen is part of the record rather than a gap in it. Shutdown
   * is what ends the day.
   */
  screenshotIntervalMinutes: number
  /**
   * Seconds without keyboard or mouse before the machine counts as idle.
   *
   * This classifies the activity timeline; it does not gate capture. A sample
   * marked idle still gets its screenshot.
   */
  idleAfterSeconds: number
}

/**
 * How the app behaves around the machine starting.
 *
 * Separate from tracking on purpose: wanting the recorder ready in the tray
 * every morning and agreeing to be tracked are two different decisions, and
 * tying them together would make one of them look like the price of the other.
 */
export interface StartupSettings {
  /** Start with the system, hidden, straight to the tray. */
  openAtLogin: boolean
  /**
   * Show a taskbar button for the window (Windows/Linux).
   *
   * Off by default: the app lives in the tray, so it keeps no taskbar button
   * and the tray menu is the way back to the window. Turning this on gives it
   * an ordinary taskbar button as well. No effect on macOS, which uses the Dock.
   */
  showInTaskbar: boolean
}

/**
 * What an administrator has switched on for one person.
 *
 * Held on their profile row, not on the machine: a local setting would be
 * theirs to turn off and invisible to anyone else, which is the opposite of
 * what a policy has to be.
 */
export interface TrackingPolicy {
  /** Whether this person's machine records activity at all. */
  trackingEnabled: boolean
  /**
   * Whether screenshots are taken while it does. Always false when tracking is
   * off — the schedule they hang off is not running.
   */
  screenshotsEnabled: boolean
}

/** One person as the admin panel lists them, with their policy. */
export interface TrackedPerson {
  id: string
  email: string
  name: string
  role: UserRole
  /**
   * The role exactly as stored.
   *
   * `role` above is narrowed to the names the code knows, so a role somebody
   * has since invented reads as `user` there. This is what the role picker on
   * the Team screen sets and shows.
   */
  roleKey: string
  trackingEnabled: boolean
  screenshotsEnabled: boolean
}

/* -------------------------------------------------------------------------- */
/*                                  KPI notes                                 */
/* -------------------------------------------------------------------------- */

/** One of the people a KPI note was addressed to, by their Nexus identity. */
export interface KpiRecipient {
  nexusId: string
  name: string
}

/** A KPI or note a super admin has put on somebody's dashboard. */
export interface KpiNote {
  id: string
  body: string
  /** The author's name as it stood when they wrote it. */
  authorName: string
  createdAt: string
  /**
   * Who else it went to.
   *
   * Only ever filled in for a super admin. Everybody else may read their own
   * row in the audience and no other, so for them this is empty rather than a
   * list of one that reads like the whole audience.
   */
  recipients: KpiRecipient[]
}

/* -------------------------------------------------------------------------- */
/*                            Roles and permissions                           */
/* -------------------------------------------------------------------------- */

/** One thing the app knows how to gate. */
export interface PermissionInfo {
  key: string
  /** Which part of the app it belongs to, so the screen can group them. */
  module: string
  label: string
  description: string
}

/**
 * One person's exception to what their role gives them.
 *
 * `granted` is the whole point: `true` adds a permission the role does not
 * carry, `false` takes one away that it does. Anything with no row here simply
 * follows the role.
 */
export interface UserPermission {
  permissionKey: string
  granted: boolean
}

/** A role, and what it carries. */
export interface AppRole {
  key: string
  label: string
  /**
   * Answers yes to everything without a lookup, and cannot be edited from the
   * app. Only a super admin has it — it is what stops whoever administers
   * permissions from locking themselves out of the screen that administers
   * them.
   */
  fullAccess: boolean
  /** One of the three the code names by hand. Re-permissionable, not removable. */
  builtIn: boolean
  /** Permission keys. Empty for a full-access role, which needs none. */
  permissions: string[]
}

/* -------------------------------------------------------------------------- */
/*                                Task boards                                 */
/* -------------------------------------------------------------------------- */

/** How urgent a card is. Stored as text so a new level is a migration, not an enum dance. */
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent'

/** One of the people a card is for, or a board is open to, by Nexus identity. */
export interface TaskPerson {
  nexusId: string
  name: string
}

/** A board as it appears in the picker, without its lists or cards. */
export interface TaskBoard {
  id: string
  name: string
  /** Who opened it. Only they, or a super admin, may rename or remove it. */
  createdBy: string
  createdAt: string
  members: TaskPerson[]
  /** How much is on it, so the picker can say something without loading it. */
  cardCount: number
}

/** One column on a board. */
export interface TaskList {
  id: string
  boardId: string
  name: string
  position: number
}

/** A piece of work. */
export interface TaskCard {
  id: string
  listId: string
  boardId: string
  title: string
  description: string
  position: number
  /** ISO 8601, or null when nothing is due. */
  dueAt: string | null
  priority: TaskPriority
  createdAt: string
  updatedAt: string
  assignees: TaskPerson[]
  /** How many notes are on it, so the tile can say so without loading them. */
  noteCount: number
  /**
   * Whether this account may read the thread on this task.
   *
   * Narrower than being able to see the task: the notes are for the people it
   * is assigned to, and for anybody who can see every task. Worked out by the
   * server with the rule the policy uses, so the window never offers a thread
   * that would come back empty.
   */
  notesVisible: boolean
  /**
   * Whether this account may change this task.
   *
   * Worked out by the server with the same rule the policy uses, rather than in
   * the window — which knows the permissions but not who wrote the task, and
   * would have to be told that anyway. One answer, from the side that decides.
   */
  editable: boolean
}

/** One thing somebody said on a task. */
export interface TaskNote {
  id: string
  cardId: string
  /** The account that wrote it — used to tell your own notes from everybody else's. */
  authorId: string
  /** Their name as it stood when they wrote it. */
  authorName: string
  body: string
  createdAt: string
  /** Whether this account may take it back. Own notes always; others by permission. */
  removable: boolean
}

/**
 * A task falling due today, for the dashboard.
 *
 * Carries the project's name because it is read outside any project: on a board
 * the column you are looking at says where you are, and on a dashboard nothing
 * does.
 */
export interface TaskDueToday extends TaskCard {
  boardName: string
}

/** One board with everything on it — what the board screen renders from. */
export interface TaskBoardDetail {
  board: TaskBoard
  lists: TaskList[]
  cards: TaskCard[]
}

/** What a new card needs, and what may be changed about an existing one. */
export interface TaskCardInput {
  title: string
  description?: string
  dueAt?: string | null
  priority?: TaskPriority
  /** Nexus ids. Passing an array replaces the whole assignee list. */
  assigneeNexusIds?: string[]
}

/**
 * Where a card ended up, as the two cards it was dropped between.
 *
 * Neighbours rather than a number: the window knows what the card was dropped
 * between, and the position that implies is the server's to work out. Null on
 * either side means the top or the bottom of the list.
 */
export interface TaskCardMove {
  toListId: string
  beforeCardId: string | null
  afterCardId: string | null
}

/** One capture, with a link the window can actually load. */
export interface ActivityScreenshot {
  capturedAt: string
  storagePath: string
  /** Signed, time-limited. Null when the link could not be made. */
  url: string | null
}

/**
 * One window's counts.
 *
 * Integers only. `inputAvailable` is false where the machine could not count at
 * all — a refused macOS permission, or Wayland — so a window nobody could
 * measure is never read as a window nobody worked in.
 */
export interface ActivityInterval {
  startedAt: string
  endedAt: string
  keyPresses: number
  mouseClicks: number
  scrolls: number
  activeSeconds: number
  inputAvailable: boolean | null
}

/** Everything recorded for one person on one day. */
export interface ActivityDay {
  segments: ActivitySegment[]
  screenshots: ActivityScreenshot[]
  intervals: ActivityInterval[]
  activeMs: number
  idleMs: number
  /** Totals across the day's windows, for the summary row. */
  keyPresses: number
  mouseClicks: number
  scrolls: number
  /**
   * Wall-clock the machine was on and tracking, from the windows themselves.
   *
   * Not the same as active + idle: those come from the segments, which stop at
   * the last state change, while a window covers real elapsed time either way.
   */
  trackedMs: number
  /**
   * Share of that time spent at the keyboard, 0-100.
   *
   * Null when nothing was tracked, which is a different answer from zero —
   * a day with no windows had no measurement, not no work.
   */
  activePercent: number | null
}

/**
 * A run of one state, as the tracker records it.
 *
 * Stored as stretches rather than as one row per sample: a day is dozens of
 * these, not hundreds of identical ticks, and a stretch is what anyone reading
 * the day actually wants to see.
 */
export interface ActivitySegment {
  /** ISO 8601 instant the stretch began. */
  startedAt: string
  /** ISO 8601 instant it ended. Equal to `startedAt` for a stretch still open. */
  endedAt: string
  state: 'active' | 'idle'
}

/* -------------------------------------------------------------------------- */
/*                                  Shortcuts                                 */
/* -------------------------------------------------------------------------- */

export interface ShortcutSettings {
  /**
   * The key that starts and stops a recording from anywhere on the machine.
   *
   * An Electron accelerator — `Control+Space`, `Control+Shift+R`. Registered
   * globally, so it works while the app is in the tray and somebody is in a
   * call; empty switches it off entirely.
   */
  toggleRecording: string
}

/** How a recording's speech is read back as text. */
export interface TranscriptSettings {
  model: WhisperModelKey
}

export interface AppSettings {
  video: VideoSettings
  audio: AudioSettings
  storage: StorageSettings
  notifications: NotificationSettings
  startup: StartupSettings
  shortcuts: ShortcutSettings
  transcript: TranscriptSettings
  tracking: TrackingSettings
  experimental: ExperimentalSettings
  /** Schema version, used to migrate persisted settings between releases. */
  schemaVersion: number
}

/* -------------------------------------------------------------------------- */
/*                               Capture sources                              */
/* -------------------------------------------------------------------------- */

export type CaptureSourceKind = 'screen' | 'window'

export interface CaptureSource {
  /** `chromeMediaSourceId` handed to `getUserMedia`. */
  id: string
  name: string
  kind: CaptureSourceKind
  /** Data URL of a preview thumbnail, or `null` when unavailable. */
  thumbnail: string | null
  /** Electron display id for screen sources, used for multi-monitor mapping. */
  displayId: string | null
  /**
   * True when this entry only names a display and cannot be captured as it
   * stands. Wayland sessions are populated this way so that merely listing the
   * screens does not open a capture session: `sources.resolve()` exchanges the
   * chosen placeholder for a real source when recording starts.
   */
  placeholder?: boolean
}

/* -------------------------------------------------------------------------- */
/*                                  Accounts                                  */
/* -------------------------------------------------------------------------- */

/**
 * The signed-in account, as far as the UI is concerned.
 *
 * Deliberately minimal: access and refresh tokens never leave the main process,
 * so nothing that reaches the renderer can be used to talk to Supabase.
 */
/**
 * Authorisation level, mirrored from `public.profiles.role`.
 *
 * Read-only as far as the app is concerned: the database refuses any attempt to
 * change it from a client session, so this is something to *display* and to
 * hide irrelevant UI with — never the thing that guards the data. That job
 * belongs to row level security.
 */
export type UserRole = 'user' | 'admin' | 'super_admin'

export interface AuthUser {
  id: string
  email: string
  /** Display name. Falls back to the local part of the email when unset. */
  name: string
  role: UserRole
  /**
   * The role exactly as stored.
   *
   * `role` above is narrowed to the three the code knows by name, so a role
   * somebody has invented since reads as `user` there — the least privileged
   * answer. This is the real one, for showing and for the screen that hands
   * roles out. What somebody may actually *do* is `permissions`, not either.
   */
  roleKey: string
  /** The role's own name for itself, for showing rather than testing. */
  roleLabel: string
  /** True for a role that answers yes to everything. Only a super admin has it. */
  fullAccess: boolean
  /**
   * What this account may do, resolved from its role at sign-in.
   *
   * Used to decide what the window offers. It is not the protection — the
   * database refuses what it refuses regardless of what is drawn here — and it
   * is a snapshot, so it is re-read when the window is shown.
   */
  permissions: string[]
  /**
   * Who this person is in Nexus.
   *
   * The Call Manager works in these rather than in account ids, because a call
   * can be scheduled for somebody who has never opened this app. The window
   * needs it to put the signed-in person's own name in a picker beside
   * everybody else's.
   *
   * Null only for an account that predates Nexus and has not signed in since.
   */
  nexusUserId: string | null
}

export interface SignInInput {
  email: string
  password: string
}

/*
 * No `SignUpInput`, `UpdateProfileInput` or `ChangePasswordInput`.
 *
 * Credentials belong to Nexus: accounts are created there, passwords are set
 * there, and a name typed here would be overwritten by the next sign-in. The
 * only thing this app asks anybody for is an email and a password to check.
 */

/* -------------------------------------------------------------------------- */
/*                                Call manager                                */
/* -------------------------------------------------------------------------- */

/**
 * `missed` is not something the user picks: the app applies it when a call ends
 * while still marked `scheduled`. They can correct it afterwards.
 */
export type ScheduledCallStatus = 'scheduled' | 'completed' | 'cancelled' | 'missed'

/**
 * One person a call is for.
 *
 * Identified by their Nexus id rather than by an account here, because a call
 * can be scheduled for somebody who has never opened this app — it is simply
 * waiting for them the first time they sign in.
 */
export interface CallAssignee {
  nexusId: string
  name: string
  /**
   * The person the call is really for, as against the others on it.
   *
   * A display distinction only: everybody on a call sees it and is reminded
   * about it in exactly the same way.
   */
  isPrimary: boolean
}

/** One person as the assignment picker lists them. */
export interface RosterPerson {
  nexusId: string
  name: string
  /** False once they stop appearing in Nexus's roster — they have left. */
  active: boolean
}

/**
 * A call somebody has planned.
 *
 * Lives in Supabase rather than in local settings, so the schedule follows the
 * account onto another machine. Unrelated to the recordings library: this says
 * what is going to happen, not what was captured.
 *
 * Who arranged it and who it is *for* are different questions. A call scheduled
 * for three colleagues appears in their day, not in the day of whoever set it
 * up — that person finds it under "Scheduled by me".
 */
export interface ScheduledCall {
  id: string
  title: string
  /** ISO 8601 with offset. The UI renders it in local time. */
  startsAt: string
  durationMinutes: number
  notes: string
  status: ScheduledCallStatus
  createdAt: string
  /**
   * Where the call came from.
   *
   * `null` for a call the user typed in. Otherwise the connected Google account
   * whose calendar it was imported from — which is also how the UI colours it,
   * and how a re-sync finds the row again.
   */
  googleAccountEmail: string | null
  /** The Google Calendar event id, when this call was imported. */
  googleEventId: string | null
  /** Everybody the call is for, primary first. */
  assignees: CallAssignee[]
  /** True when the signed-in person arranged this call, whoever it is for. */
  scheduledByMe: boolean
  /** True when the signed-in person is one of the people it is for. */
  assignedToMe: boolean
}

/** True when a call mirrors a Google Calendar event rather than being typed in. */
export function isImportedCall(call: ScheduledCall): boolean {
  return call.googleEventId !== null
}

/** Fields the user supplies when creating or editing a call. */
export interface ScheduledCallInput {
  title: string
  startsAt: string
  durationMinutes: number
  notes: string
  status?: ScheduledCallStatus
  /**
   * Who the call is for, by Nexus id. The first entry is the primary.
   *
   * An empty list means the person arranging it — which is what a call somebody
   * schedules for themselves looks like, and what every imported Google event
   * is.
   */
  assigneeNexusIds?: string[]
}

/**
 * Which calls a listing is asking for.
 *
 * `assigned` is the schedule — what this person has to be at. `scheduled-by-me`
 * is the other question, and the reason it exists at all: somebody who arranges
 * a call for three colleagues has to be able to find it again to move or cancel
 * it, without it cluttering a day they are not part of.
 *
 * `all` is everybody's calls, and it is only ever answered for an admin or a
 * super admin — the roles that run the calls. Asking for it as an ordinary user
 * is not an error; it simply gets that person's own schedule back, because the
 * question they are entitled to ask is the only one the main process will put
 * to the database.
 */
export type CallScope = 'assigned' | 'scheduled-by-me' | 'all'

/* -------------------------------------------------------------------------- */
/*                              Google Calendar                               */
/* -------------------------------------------------------------------------- */

/**
 * A Google account whose calendar is being imported.
 *
 * Several can be connected at once — the colour is what distinguishes their
 * calls in the calendar. Tokens live in the main process and are never part of
 * this shape.
 */
export interface GoogleAccount {
  email: string
  /** Hex colour assigned by connection order. */
  color: string
  connectedAt: string
  /**
   * True once Google has refused to renew this account's access.
   *
   * Nothing can be done about it in the background: a refresh token is the
   * credential itself, and only the user consenting again in a browser makes a
   * new one. The flag exists so the UI can say so and offer that in one click,
   * rather than leaving a calendar that silently stopped updating.
   */
  expired: boolean
}

/**
 * What one sync run did.
 *
 * `failures` is per account rather than an exception: connecting three
 * calendars is exactly so that one going wrong still leaves the others
 * working, and the UI names the one that did not.
 */
export interface GoogleCalendarSyncResult {
  imported: number
  updated: number
  removed: number
  failures: Array<{ email: string; message: string }>
}

/* -------------------------------------------------------------------------- */

/** Half-open window `[from, to)` used to fetch a month at a time. */
export interface ScheduledCallRange {
  from: string
  to: string
}

/* -------------------------------------------------------------------------- */
/*                                 MCP server                                 */
/* -------------------------------------------------------------------------- */

/**
 * The local MCP server that lets this employee's Claude schedule/list/cancel
 * their own calls, instead of the Call Manager form. Loopback-only, gated by
 * `token` — the Settings page turns this into a ready-made `.mcp.json` block.
 */
export interface McpServerStatus {
  running: boolean
  url: string
  port: number
  token: string
}

/** A warning about a call that is about to start, sent to the renderer for its own toast. */
export interface CallReminder {
  callId: string
  title: string
  startsAt: string
  /** How much warning this reminder gave. `0` means "starting now". */
  leadMinutes: number
}

/* -------------------------------------------------------------------------- */
/*                              Recording session                             */
/* -------------------------------------------------------------------------- */

export type RecordingState =
  | 'idle'
  | 'preparing'
  | 'recording'
  | 'paused'
  | 'stopping'
  | 'processing'
  | 'error'

export interface SessionHandle {
  sessionId: string
  /** Absolute path of the intermediate container being streamed to disk. */
  tempPath: string
  startedAt: number
}

/** Metadata handed to the main process when a recording is finalised. */
export interface FinalizeRequest {
  sessionId: string
  /** Wall-clock recording duration in milliseconds. */
  durationMs: number
  /** Native capture dimensions, used to decide whether rescaling is needed. */
  width: number
  height: number
  hasAudio: boolean
  /** MIME type the renderer's MediaRecorder actually produced. */
  mimeType: string
}

export interface FinalizeResult {
  /** Catalog id of the saved recording. */
  recordingId: string
  outputPath: string
  fileSizeBytes: number
  durationMs: number
  /** Name of the FFmpeg encoder that produced the file (e.g. `libx264`). */
  encoder: string
  /** True when a hardware encoder was requested but FFmpeg fell back to CPU. */
  usedFallbackEncoder: boolean
  /**
   * Whether a hard-panned audio copy was kept beside this recording.
   *
   * False for a silent capture, and for one whose voice track could not be
   * written — in both cases there is nothing to transcribe, and the UI should
   * say so rather than offer a button that cannot work.
   */
  hasVoiceTrack: boolean
}

export type ProcessingStage = 'queued' | 'encoding' | 'finalizing' | 'done' | 'failed'

export interface ProcessingProgress {
  sessionId: string
  stage: ProcessingStage
  /** 0 – 100. */
  percent: number
  /** Human readable detail line, e.g. "encoding 00:01:12 @ 1.8x". */
  detail: string
}

/* -------------------------------------------------------------------------- */
/*                              Recordings library                            */
/* -------------------------------------------------------------------------- */

/**
 * One recording in the library.
 *
 * The library is a catalog rather than a folder listing: entries keep their
 * absolute path, so recordings stay listed after the output folder changes and
 * can live in several places at once.
 */
export interface RecordingEntry {
  /** Opaque, stable identifier. Everything the UI does is keyed by this. */
  id: string
  /** File name including the `.mp4` extension. Not necessarily unique. */
  fileName: string
  /** Absolute path on disk. */
  filePath: string
  /**
   * False when the file is no longer at `filePath` — moved, renamed or deleted
   * outside the app. The entry stays listed so the user can remove it or put
   * the file back.
   */
  available: boolean
  /**
   * URL the renderer can hand to a `<video>` element. Served by the app's
   * private `app-recording://` protocol, which resolves the id through the
   * catalog and never accepts a path from the renderer.
   */
  playbackUrl: string
  /**
   * URL of a generated poster frame, or `null` if one could not be produced.
   * Served through the same private protocol as the video.
   */
  thumbnailUrl: string | null
  sizeBytes: number
  /** Epoch milliseconds the file was created. */
  createdAt: number
  /** Recording length, or `null` when it is not known. */
  durationMs: number | null
  width: number | null
  height: number | null
  /** Free-text note the user attached to this recording. Empty when unset. */
  note: string
}

/* -------------------------------------------------------------------------- */
/*                                    Tray                                    */
/* -------------------------------------------------------------------------- */

/** Transport commands the tray menu can issue to the renderer. */
export type TrayCommand = 'start' | 'stop' | 'pause' | 'resume'

/**
 * Minimal recording state mirrored into the main process so the tray menu can
 * enable, disable and relabel its items without owning the pipeline.
 */
export interface RecorderStateSync {
  state: RecordingState
  elapsedMs: number
  /** True when a capture source is selected and a recording could start. */
  canStart: boolean
}

/* -------------------------------------------------------------------------- */
/*                                  Recovery                                  */
/* -------------------------------------------------------------------------- */

/**
 * An intermediate file left behind by a crashed or force-quit session.
 * Surfaced on the next launch so the user can still salvage the recording.
 */
export interface OrphanRecording {
  sessionId: string
  tempPath: string
  sizeBytes: number
  createdAt: number
}

/* -------------------------------------------------------------------------- */
/*                                 App / misc                                 */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                              Media permissions                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether the OS lets this app reach a capture device.
 *
 * `not-required` is the answer on Windows and Linux, where screen and
 * microphone access is not gated per application the way macOS gates it.
 */
export type MediaPermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unknown'
  | 'not-required'

export interface MediaPermissions {
  /** Screen recording. On macOS this is only ever granted from System Settings. */
  screen: MediaPermissionState
  microphone: MediaPermissionState
  /**
   * Whether macOS will report input that happened in other applications.
   *
   * Activity tracking counts keystrokes and clicks across the machine, and
   * macOS refuses that to an untrusted application — not with an error, but by
   * delivering nothing. Without this the counters sit at zero and a working day
   * reads as an idle one, which looks like data rather than like a refusal.
   *
   * `not-required` everywhere but macOS: Windows and Linux hand global input
   * hooks to any process that asks.
   */
  accessibility: MediaPermissionState
}

/** The privacy panes the app knows how to open. */
export type PermissionKind = 'screen' | 'microphone' | 'accessibility'

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*                                   Updates                                  */
/* -------------------------------------------------------------------------- */

/**
 * Where this machine has got to with the next version.
 *
 * One value rather than a set of booleans, because the states are exclusive and
 * the banner renders exactly one of them. `unsupported` is the honest answer in
 * development and for the portable build, neither of which can replace itself.
 */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'
  | 'unsupported'

export interface UpdateStatus {
  state: UpdateState
  /** The version waiting, once one is known. */
  version: string | null
  /** 0-100 while downloading, null otherwise. */
  progress: number | null
  /** What went wrong, for `error`, or why updating is not possible. */
  message: string | null
  /** When the last check finished, as an ISO string. Null before the first. */
  checkedAt: string | null
}

export interface AppInfo {
  version: string
  electronVersion: string
  chromeVersion: string
  /** `process.platform` value, e.g. `win32`, `darwin` or `linux`. */
  platform: string
  /** Absolute path to the FFmpeg binary that will be used, or null if missing. */
  ffmpegPath: string | null
  ffmpegVersion: string | null
  /** Directory the log file lives in. */
  logDirectory: string
  /** Folder recordings are currently written to (default or user-chosen). */
  recordingsDirectory: string
  /** The app-managed folder used when no custom output folder is configured. */
  defaultRecordingsDirectory: string
  /**
   * True when the platform can capture system audio through Chromium's desktop
   * loopback (Windows). Linux needs a PulseAudio monitor device instead, and
   * macOS needs a virtual audio device such as BlackHole.
   */
  supportsNativeLoopback: boolean
  /**
   * True when this build carries a Google OAuth client. False hides the Calendar
   * integration entirely rather than offering a Connect button that cannot work.
   */
  googleConfigured: boolean
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogPayload {
  level: LogLevel
  scope: string
  message: string
  data?: unknown
}

/** Discriminated result wrapper used by every invoke-style IPC handler. */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: SerializedError }

export interface SerializedError {
  code: string
  message: string
  /** Optional operator-facing hint, e.g. how to install a missing dependency. */
  hint?: string
}

/* -------------------------------------------------------------------------- */
/*                                 Transcripts                                */
/* -------------------------------------------------------------------------- */

/** The speech models offered for transcription, smallest first. */
export type WhisperModelKey = 'base' | 'small' | 'medium'

export interface WhisperModelStatus {
  key: WhisperModelKey
  label: string
  /** What choosing it costs and buys, in a sentence. */
  note: string
  /** Roughly what it weighs, for the prompt before downloading it. */
  approxMb: number
  installed: boolean
  /** Actual size on disk, or 0 when it has not been downloaded. */
  sizeBytes: number
}

/**
 * Which side of the conversation a line came from.
 *
 * `me` and `them` are only knowable when the two were recorded on separate
 * channels — this app's own captures, and the occasional imported file from a
 * call recorder that does the same. Everything else arrives already mixed, and
 * `unknown` says so rather than guessing.
 */
export type TranscriptSpeaker = 'me' | 'them' | 'unknown'

export interface TranscriptSegment {
  speaker: TranscriptSpeaker
  /** Milliseconds from the start of the recording — the video's own clock. */
  startMs: number
  endMs: number
  text: string
}

export type TranscriptStage =
  | 'queued'
  | 'downloading-model'
  | 'splitting'
  | 'transcribing'
  | 'done'
  | 'failed'

export interface TranscriptProgress {
  /** The recording's catalogue id, or the id a transcribed file is filed under. */
  id: string
  stage: TranscriptStage
  /** 0-100, or null while the work has no measurable length. */
  percent: number | null
  detail: string
}

export interface Transcript {
  id: string
  /**
   * The file this came from, when it did not come from a recording.
   *
   * Empty for the app's own captures, which are named by the library instead.
   */
  sourceName: string
  model: WhisperModelKey
  /** What Whisper heard, before translating. Empty when it could not tell. */
  detectedLanguage: string
  createdAt: number
  /** How long the transcription itself took, for the "worth it?" question. */
  tookMs: number
  segments: TranscriptSegment[]
}
