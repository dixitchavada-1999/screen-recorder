/**
 * Canonical list of IPC channel names.
 *
 * The preload bridge only forwards channels present in this map, which keeps
 * the renderer from being able to reach arbitrary main-process handlers.
 */
export const IPC = {
  /* invoke — renderer → main → renderer */
  APP_INFO: 'app:info',

  SETTINGS_GET: 'settings:get',
  SETTINGS_UPDATE: 'settings:update',
  SETTINGS_RESET: 'settings:reset',

  SOURCES_LIST: 'sources:list',
  /** Exchanges a picked entry for a source that can actually be captured. */
  SOURCES_RESOLVE: 'sources:resolve',

  /* OS media permissions (macOS grants these per app; Windows and Linux do not) */
  PERMISSIONS_GET: 'permissions:get',
  PERMISSIONS_REQUEST_MICROPHONE: 'permissions:request-microphone',
  /** macOS only: raises the prompt that points at Accessibility settings. */
  PERMISSIONS_REQUEST_ACCESSIBILITY: 'permissions:request-accessibility',
  /** Opens the OS privacy pane the user has to flip the switch in. */
  PERMISSIONS_OPEN_SETTINGS: 'permissions:open-settings',

  /* Accounts */
  /*
   * Sign-in only.
   *
   * Accounts, names and passwords all live in Nexus, so there is no sign-up,
   * rename or password-change channel to expose — the app has no way to make
   * any of them happen and should not offer a control that pretends otherwise.
   */
  AUTH_SESSION: 'auth:session',
  AUTH_SIGN_IN: 'auth:sign-in',
  AUTH_SIGN_OUT: 'auth:sign-out',
  AUTH_SIGN_OUT_ALL: 'auth:sign-out-all',

  /* Google Calendar accounts */
  GOOGLE_ACCOUNTS: 'google:accounts',
  GOOGLE_CONNECT: 'google:connect',
  GOOGLE_DISCONNECT: 'google:disconnect',
  /** Pulls one date range from every connected calendar into `scheduled_calls`. */
  GOOGLE_SYNC: 'google:sync',

  /* Activity tracking */
  TRACKING_POLICY: 'tracking:policy',
  TRACKING_PEOPLE: 'tracking:people',
  TRACKING_SET_POLICY: 'tracking:set-policy',
  /** One person's recorded day, for the admin panel. */
  TRACKING_DAY: 'tracking:day',

  /* Call manager */
  /** The people a call can be scheduled for — this app's cache of the roster. */
  /** KPI notes: what is on my dashboard, and — for an admin — putting it there. */
  KPI_LIST: 'kpi:list',
  KPI_CREATE: 'kpi:create',
  KPI_DELETE: 'kpi:delete',

  /* Roles and permissions: who may do what, kept as data rather than code. */
  ROLES_LIST: 'roles:list',
  ROLES_CATALOGUE: 'roles:catalogue',
  ROLES_CREATE: 'roles:create',
  ROLES_RENAME: 'roles:rename',
  ROLES_DELETE: 'roles:delete',
  /** Replaces the whole grant set for one role. */
  ROLES_SET_PERMISSIONS: 'roles:set-permissions',
  /** Moves one person onto a different role. */
  ROLES_SET_USER: 'roles:set-user',
  /** One person's own exceptions to their role. */
  ROLES_USER_PERMISSIONS: 'roles:user-permissions',
  ROLES_SET_USER_PERMISSIONS: 'roles:set-user-permissions',

  /* Task boards: the kanban module. */
  TASKS_BOARDS: 'tasks:boards',
  TASKS_BOARD_CREATE: 'tasks:board-create',
  TASKS_BOARD_RENAME: 'tasks:board-rename',
  TASKS_BOARD_DELETE: 'tasks:board-delete',
  /** Replaces the whole membership list in one call. */
  TASKS_BOARD_MEMBERS: 'tasks:board-members',
  /** One board with its lists, cards and assignees. */
  TASKS_BOARD: 'tasks:board',
  /** Everything falling due today, across every project in reach. */
  TASKS_DUE_TODAY: 'tasks:due-today',

  TASKS_LIST_CREATE: 'tasks:list-create',
  TASKS_LIST_RENAME: 'tasks:list-rename',
  TASKS_LIST_DELETE: 'tasks:list-delete',

  TASKS_CARD_CREATE: 'tasks:card-create',
  TASKS_CARD_UPDATE: 'tasks:card-update',
  /** Where it was dropped, as neighbours. The server works out the position. */
  TASKS_CARD_MOVE: 'tasks:card-move',
  TASKS_CARD_DELETE: 'tasks:card-delete',

  /** The conversation on one task. */
  TASKS_NOTES: 'tasks:notes',
  TASKS_NOTE_ADD: 'tasks:note-add',
  TASKS_NOTE_DELETE: 'tasks:note-delete',

  ROSTER_LIST: 'roster:list',
  /** Asks the server to refresh that cache. It refuses more than once a day. */
  ROSTER_SYNC: 'roster:sync',

  CALLS_LIST: 'calls:list',
  CALLS_CREATE: 'calls:create',
  CALLS_UPDATE: 'calls:update',
  /** Changes only the status, leaving the rest of the call untouched. */
  CALLS_SET_STATUS: 'calls:set-status',
  CALLS_DELETE: 'calls:delete',

  SHELL_OPEN_PATH: 'shell:open-path',
  SHELL_REVEAL_ITEM: 'shell:reveal-item',

  /* Recordings library */
  LIBRARY_LIST: 'library:list',
  LIBRARY_DELETE: 'library:delete',
  LIBRARY_FORGET: 'library:forget',
  LIBRARY_EXPORT: 'library:export',
  LIBRARY_OPEN_FOLDER: 'library:open-folder',
  LIBRARY_SET_NOTE: 'library:set-note',
  /** Opens the OS folder picker used to choose where recordings are stored. */
  LIBRARY_CHOOSE_FOLDER: 'library:choose-folder',

  RECORDING_BEGIN: 'recording:begin',
  RECORDING_WRITE_CHUNK: 'recording:write-chunk',
  RECORDING_FINALIZE: 'recording:finalize',
  RECORDING_ABORT: 'recording:abort',

  RECOVERY_LIST: 'recovery:list',
  RECOVERY_RESTORE: 'recovery:restore',
  RECOVERY_DISCARD: 'recovery:discard',

  LOG_WRITE: 'log:write',

  /** Renderer pushes its recording state so the tray menu can reflect it. */
  RECORDER_STATE_SYNC: 'recorder:state-sync',

  WINDOW_HIDE: 'window:hide',

  /**
   * Takes this window out of whatever is being recorded, and puts it back.
   *
   * An invoke rather than a send, because the renderer has to know the window
   * is out of shot before it grabs the first frame.
   */
  WINDOW_EXCLUDE_FROM_CAPTURE: 'window:exclude-from-capture',

  /* Updates */
  /** Asks the update server whether there is a newer version. */
  UPDATE_CHECK: 'update:check',
  /** Starts downloading the version that was found. */
  UPDATE_DOWNLOAD: 'update:download',
  /** Quits and installs what has been downloaded. */
  UPDATE_INSTALL: 'update:install',
  /** The current state, for a window that has just opened. */
  UPDATE_STATUS: 'update:status',

  /* send — main → renderer (one-way events) */
  EVENT_PROCESSING_PROGRESS: 'event:processing-progress',
  EVENT_SETTINGS_CHANGED: 'event:settings-changed',
  EVENT_REQUEST_STOP: 'event:request-stop',
  /** A transport command issued from the tray menu. */
  EVENT_TRAY_COMMAND: 'event:tray-command',
  /** The window was just brought back from the tray, so the view resets home. */
  EVENT_WINDOW_SHOWN: 'event:window-shown',
  /** The tray asking the window to land somewhere in particular. */
  EVENT_OPEN_SECTION: 'event:open-section',
  /** A session arrived from outside the window, e.g. an email confirmation link. */
  EVENT_AUTH_CHANGED: 'event:auth-changed',
  /** That link could not be completed. */
  EVENT_AUTH_ERROR: 'event:auth-error',
  /** A scheduled call is about to start. */
  EVENT_CALL_REMINDER: 'event:call-reminder',
  /** The update state changed — found, downloading, ready, failed. */
  EVENT_UPDATE_STATUS: 'event:update-status'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/** Error codes surfaced to the UI so it can render actionable messages. */
export const ERROR_CODES = {
  FFMPEG_MISSING: 'FFMPEG_MISSING',
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_EMPTY: 'SESSION_EMPTY',
  WRITE_FAILED: 'WRITE_FAILED',
  OUTPUT_NOT_WRITABLE: 'OUTPUT_NOT_WRITABLE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  /** Sign-in, sign-up or session refresh was refused. Message is user-facing. */
  AUTH_FAILED: 'AUTH_FAILED',
  /** The build carries no Supabase project, so accounts are unavailable. */
  AUTH_NOT_CONFIGURED: 'AUTH_NOT_CONFIGURED',
  NO_CAPTURE_SOURCE: 'NO_CAPTURE_SOURCE',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  UNKNOWN: 'UNKNOWN'
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]
