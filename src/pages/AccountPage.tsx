import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { KpiNote, UserRole } from '@shared/types'
import { REMINDER_LEAD_OPTIONS } from '@shared/presets'
import { Avatar } from '@/components/AuthDialog'
import { KpiDialog } from '@/components/KpiDialog'
import { UpdateBanner } from '@/components/UpdateBanner'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Toggle } from '@/components/ui/Controls'
import { Tooltip } from '@/components/ui/Tooltip'
import { useAuth } from '@/context/AuthContext'
import { useSettings } from '@/context/SettingsContext'
import { useToast } from '@/context/ToastContext'
import { useAppUpdate } from '@/hooks/useAppUpdate'
import { useKpiNotes } from '@/hooks/useKpiNotes'
import { useTasksDueToday } from '@/hooks/useTasksDueToday'
import { CallManager } from '@/pages/CallManager'
import { RolesPage } from '@/pages/RolesPage'
import { TaskManager } from '@/pages/TaskManager'
import { UserActivity } from '@/pages/UserActivity'
import { AuthError } from '@/services/auth'
import { toSerializedError } from '@/services/ipc'
import { cn } from '@/utils/cn'

/** Sections of the account area, listed in the sidebar in this order. */
type Section =
  | 'dashboard'
  | 'calls'
  | 'tasks'
  | 'activity'
  | 'roles'
  | 'settings'
  | 'profile'

interface SectionDefinition {
  id: Section
  label: string
  /**
   * Only shown to somebody holding this permission.
   *
   * Every entry that is not for everybody now names one. The menu is a courtesy
   * either way — the database refuses what it refuses — but a menu built on
   * roles could not be handed out from the Roles screen, and this one can.
   */
  permission?: string
}

const SECTIONS: ReadonlyArray<SectionDefinition> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'calls', label: 'Calendar', permission: 'calendar.view' },
  { id: 'tasks', label: 'Task Manager', permission: 'tasks.view' },
  { id: 'activity', label: 'Team', permission: 'team.view' },
  { id: 'roles', label: 'Roles', permission: 'roles.view' },
  { id: 'settings', label: 'Settings' },
  { id: 'profile', label: 'Profile' }
]

interface AccountPageProps {
  /**
   * A screen something outside the window has asked for — the tray's
   * "Open Calendar", and anything like it later.
   *
   * Carries the moment it was asked, so asking twice for the same screen counts
   * twice. Ignored when it names something this account cannot see.
   */
  sectionRequest?: { section: string; at: number } | null
  /** Called after signing out, to leave a page that is no longer reachable. */
  onSignedOut: () => void
}

/**
 * The signed-in area, reached from the account chip in the top bar.
 *
 * Deliberately built from the data the app already holds — the recordings
 * library and the account itself — rather than from anything the server would
 * have to be asked for. It stays truthful offline, which the rest of the app
 * also manages to be.
 */
export function AccountPage({
  sectionRequest,
  onSignedOut
}: AccountPageProps): React.JSX.Element | null {
  const { user, signOut, can } = useAuth()
  const { push } = useToast()
  const [section, setSection] = useState<Section>('dashboard')
  const [signingOut, setSigningOut] = useState(false)

  const visibleSections = SECTIONS.filter((item) => !item.permission || can(item.permission))

  /*
   * Honoured only if the screen is one this account is actually offered — a
   * request from outside is a request, not an override.
   *
   * Asked of the filtered list and not the whole one. Against `SECTIONS` this
   * accepted any name it recognised, and the screen then rendered nothing: the
   * body checks the permission a second time, so somebody without `calendar.view`
   * who used the tray's "Open Calendar" landed on an empty panel with no item
   * lit in the menu.
   */
  useEffect(() => {
    if (!sectionRequest) return
    const wanted = visibleSections.find((item) => item.id === sectionRequest.section)
    if (wanted) setSection(wanted.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionRequest])

  /*
   * A screen that stops being allowed while it is open.
   *
   * Permissions can now change under a running window — `account-watch` sees an
   * edit within the minute and the menu redraws without the item. The body would
   * simply render nothing, leaving a blank panel that reads as the app breaking
   * rather than as access having changed. Falls back to the Dashboard, which
   * needs no permission.
   */
  const sectionAllowed = visibleSections.some((item) => item.id === section)

  useEffect(() => {
    if (!sectionAllowed) setSection('dashboard')
  }, [sectionAllowed])

  // The caller unmounts this page when the session ends; this covers the frame
  // between the two. After the hooks, so the count does not change on the way
  // out — a conditional return above them is what React counts as fewer hooks.
  if (!user) return null

  const handleSignOut = async (): Promise<void> => {
    setSigningOut(true)
    try {
      await signOut()
      push({ tone: 'info', title: 'Signed out' })
      onSignedOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="grid grid-cols-[11rem_1fr] gap-4 sm:grid-cols-[13rem_1fr]">
      {/* ------------------------------- Menu ------------------------------- */}
      <nav className="h-fit rounded-2xl border border-hairline bg-canvas-elevated/70 p-2">
        <div className="flex items-center gap-2.5 px-2 py-2.5">
          <Avatar name={user.name} size="lg" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-ink">{user.name}</p>
            <p className="truncate text-[11px] text-faint">{user.email}</p>
            {user.role === 'super_admin' && (
              <span className="mt-1 inline-flex rounded-full border border-accent/50 bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-strong">
                Super admin
              </span>
            )}
          </div>
        </div>

        <div className="my-1 h-px bg-hairline" />

        <ul className="flex flex-col gap-0.5">
          {visibleSections.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => setSection(item.id)}
                aria-current={section === item.id ? 'page' : undefined}
                className={cn(
                  'w-full rounded-xl px-3 py-2 text-left transition-colors',
                  section === item.id
                    ? 'bg-accent/15 text-accent-strong'
                    : 'text-muted hover:bg-surface hover:text-ink'
                )}
              >
                <span className="block text-sm font-medium">{item.label}</span>
              </button>
            </li>
          ))}
        </ul>

        {/*
          Signing out sits with the menu rather than inside Profile.
          It is not a thing to read about this account, it is a thing to do
          with it - and having to open a section to find it made leaving the
          app the one action nobody could see.
        */}
        <div className="my-1 h-px bg-hairline" />

        <Button
          size="sm"
          variant="danger"
          loading={signingOut}
          onClick={() => void handleSignOut()}
          className="w-full"
        >
          Sign out
        </Button>
      </nav>

      {/* ------------------------------ Content ----------------------------- */}
      {/* `min-w-0`: without it a wide child — a table, a long note — grows the
          column instead of scrolling, and pushes the menu off the window. */}
      <div className="min-w-0">
        {section === 'dashboard' && <Dashboard />}
        {section === 'calls' && can('calendar.view') && <CallManager />}
        {section === 'tasks' && can('tasks.view') && <TaskManager />}
        {/*
          Guarded on the role as well as on the menu: landing here by any other
          route — a stale state, a future deep link — must not render it.
        */}
        {section === 'activity' && can('team.view') && <UserActivity />}
        {section === 'roles' && can('roles.view') && <RolesPage />}
        {section === 'settings' && <AccountSettings currentName={user.name} />}
        {section === 'profile' && (
          <Profile name={user.name} email={user.email} id={user.id} role={user.role} />
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Dashboard                                 */
/* -------------------------------------------------------------------------- */

/**
 * The OKRs and notes on this account's dashboard.
 *
 * One list, whoever is looking. Row level security decides what it contains —
 * every note for a super admin, only the ones addressed to you for anybody else
 * — so nothing here has to ask who is reading in order to fetch the right rows.
 *
 * The role only decides what can be *done*: writing a OKR and taking one down
 * are a super admin's, and the database refuses both from anybody else whatever
 * this page renders.
 */
/**
 * The tasks falling due today.
 *
 * Renders nothing at all on a day with none — an empty "nothing due today" card
 * is a permanent strip of screen saying nothing, and the dashboard is the one
 * place where that is most expensive.
 *
 * Whose tasks these are is not decided here. The same policy that shapes a
 * board shapes this: a member of staff sees their own, and somebody who can see
 * every project sees the whole day.
 */
function DueToday(): React.JSX.Element | null {
  const { tasks, loading, error } = useTasksDueToday()

  /*
   * Nothing due and nothing readable are different things, and only the first
   * of them is silence. A failure that renders as an ordinary quiet day is a
   * failure nobody reports, because there is nothing to report.
   */
  if (error) {
    return (
      <Card title="Due today">
        <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          {error.message}
          {error.hint ? ` — ${error.hint}` : ''}
        </p>
      </Card>
    )
  }

  if (loading || tasks.length === 0) return null

  return (
    <Card
      title="Due today"
      description={`${tasks.length} ${tasks.length === 1 ? 'task is' : 'tasks are'} due before the day is out`}
    >
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tasks.map((task) => {
          const due = task.dueAt ? new Date(task.dueAt) : null

          return (
            <li
              key={task.id}
              className="flex flex-col gap-2 rounded-xl border border-hairline bg-surface/60 p-4"
            >
              <p className="line-clamp-2 break-words text-sm font-medium leading-snug text-ink">
                {task.title}
              </p>

              {/*
                The description, when there is one. A title alone often does not
                say enough to act on, and this card exists to be acted on today.
              */}
              {task.description && (
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted">
                  {task.description}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-1.5">
                {/*
                  The date, not the hour. A due date is a day — the instant
                  stored behind it is an implementation detail, and showing it
                  invited people to read a deadline into a time nobody set.
                */}
                {due && (
                  <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[10px] text-muted">
                    {due.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
                  </span>
                )}

                {task.priority !== 'normal' && (
                  <span className="rounded-md border border-hairline px-1.5 py-0.5 text-[10px] capitalize text-muted">
                    {task.priority}
                  </span>
                )}
              </div>

              <p className="mt-auto truncate text-[11px] text-faint">
                {task.boardName}
                {task.assignees.length > 0 &&
                  ` · ${task.assignees.map((person) => person.name).join(', ')}`}
              </p>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

function Dashboard(): React.JSX.Element {
  const { can } = useAuth()
  const { notes, loading, error, refresh, create, remove } = useKpiNotes()
  const update = useAppUpdate()
  const { push } = useToast()
  const [composing, setComposing] = useState(false)

  /*
   * Its own flag, not the hook's `loading`.
   *
   * That one is true only while the first read is in flight, and it also decides
   * whether the card shows a placeholder instead of its contents — so reusing it
   * for a manual refresh would blank the OKRs somebody is looking at. This spins
   * the button and leaves the screen alone.
   */
  const [refreshing, setRefreshing] = useState(false)

  const reload = async (): Promise<void> => {
    setRefreshing(true)
    try {
      await refresh()
    } finally {
      setRefreshing(false)
    }
  }

  /*
   * Setting an OKR for somebody else, as opposed to reading the ones set for
   * you — which comes with having an account and needs no permission at all.
   */
  const manages = can('okr.manage')

  const drop = async (note: KpiNote): Promise<void> => {
    try {
      await remove(note.id)
      push({ tone: 'info', title: 'OKR removed' })
    } catch (caught) {
      const failure = toSerializedError(caught)
      push({
        tone: 'error',
        title: failure.message,
        ...(failure.hint ? { description: failure.hint } : {})
      })
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Above the dashboard rather than inside it: an update is about the
          application, not about anybody's OKRs. */}
      <UpdateBanner
        status={update.status}
        onDownload={() => void update.download()}
        onInstall={() => void update.install()}
      />

      <Card
        title="Dashboard"
        description={
          manages
            ? 'Every OKR and note, and who each one is for'
            : 'The OKRs and notes set for you'
        }
        actions={
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              loading={refreshing}
              disabled={loading}
              onClick={() => void reload()}
            >
              Refresh
            </Button>

            {manages && (
              <Button size="sm" variant="primary" onClick={() => setComposing(true)}>
                + Add OKR
              </Button>
            )}
          </div>
        }
      >
        {error && (
          <p className="rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
            {error.message}
          </p>
        )}

        {!error && loading && notes.length === 0 && (
          <p className="text-xs text-faint">Loading…</p>
        )}

        {!error && !loading && notes.length === 0 && (
          <p className="text-xs leading-relaxed text-faint">
            {manages
              ? 'No OKRs yet. Add one and it appears on the dashboard of everybody you pick.'
              : 'Nothing set for you yet. Anything your administrator adds will show up here.'}
          </p>
        )}

        {/*
          Two shapes for two readers, both cards. A super admin's card carries
          the audience and a Remove; a recipient's is just the note and when it
          was set, since the audience there is only ever themselves.
        */}
        {notes.length > 0 && manages && (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {notes.map((note) => (
              <li
                key={note.id}
                className="flex flex-col rounded-xl border border-hairline bg-surface/60 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  {/* `whitespace-pre-wrap`: the line breaks somebody typed are part of it. */}
                  <p className="selectable min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                    {note.body}
                  </p>

                  <Tooltip label="Remove" side="bottom">
                    <button
                      type="button"
                      onClick={() => void drop(note)}
                      aria-label="Remove"
                      className="grid size-6 shrink-0 place-items-center rounded-md text-faint transition-colors hover:bg-record/10 hover:text-record-strong"
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 20 20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        className="size-4"
                      >
                        <path d="M6 6l8 8M14 6l-8 8" />
                      </svg>
                    </button>
                  </Tooltip>
                </div>

                {note.recipients.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1">
                    {note.recipients.map((person) => (
                      <li
                        key={person.nexusId}
                        className="rounded-full border border-hairline bg-canvas-elevated px-2 py-0.5 text-[11px] text-muted"
                      >
                        {person.name}
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-2 text-[11px] text-faint">{formatNoteDate(note.createdAt)}</p>
              </li>
            ))}
          </ul>
        )}

        {notes.length > 0 && !manages && (
          <ul className="flex flex-col gap-2.5">
            {notes.map((note) => (
              <li
                key={note.id}
                className="rounded-xl border border-hairline bg-surface/60 px-4 py-3"
              >
                <p className="selectable whitespace-pre-wrap text-sm leading-relaxed text-ink">
                  {note.body}
                </p>

                <p className="mt-2 text-[11px] text-faint">
                  {note.authorName || 'Administrator'} · {formatNoteDate(note.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        Under the OKRs, and only on a day that has any.

        The dashboard is what somebody opens the account area onto, and the OKRs
        are what it is for — so they keep the top. What is due today is a strip
        beneath them, present when there is something in it and absent when
        there is not.
      */}
      {can('tasks.view') && <DueToday />}

      {manages && (
        <KpiDialog
          open={composing}
          onClose={() => setComposing(false)}
          onSave={create}
        />
      )}
    </div>
  )
}

/** Short and absolute — a OKR is a thing said on a day, not "3 days ago". */
function formatNoteDate(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''

  return at.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

/* -------------------------------------------------------------------------- */
/*                              Account settings                              */
/* -------------------------------------------------------------------------- */

/**
 * The settings that belong to the account rather than to this installation.
 *
 * Video, audio and storage stay on the app's own Settings tab: they are
 * properties of this computer and keep working with nobody signed in.
 */
function AccountSettings({ currentName }: { currentName: string }): React.JSX.Element {
  const { signOutEverywhere } = useAuth()
  const { push } = useToast()

  const [signingOutAll, setSigningOutAll] = useState(false)

  const handleSignOutEverywhere = async (): Promise<void> => {
    setSigningOutAll(true)
    try {
      await signOutEverywhere()
      push({ tone: 'info', title: 'Signed out on every device' })
    } catch (error) {
      push({ tone: 'error', title: messageOf(error) })
    } finally {
      setSigningOutAll(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/*
        ------------------------------ Identity -----------------------------

        Stated rather than editable. The name and the password both belong to
        Nexus — a field here would accept an edit and then have it overwritten
        by the next sign-in, which is a worse answer than saying where the edit
        actually belongs.
      */}
      <Card
        title="Your details"
        description="Managed in Nexus, and copied here each time you sign in"
      >
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-[16rem] flex-1 rounded-xl border border-hairline bg-surface px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Name</p>
            <p className="selectable mt-0.5 truncate text-sm text-ink">{currentName}</p>
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-faint">
          To change your name or your password, do it in Nexus. A new password works here
          immediately; a new name appears the next time you sign in.
        </p>
      </Card>

      {/* ------------------------------ Window ------------------------------ */}
      <WindowSettings />

      {/* --------------------------- Notifications -------------------------- */}
      <CallReminderSettings />

      {/* ----------------------------- Sessions ----------------------------- */}
      <Card title="Sessions" description="Where this account is currently signed in">
        <p className="text-xs leading-relaxed text-faint">
          Signing out everywhere ends the session on every computer this account is open on,
          including this one. Use it if you have signed in somewhere you no longer control.
        </p>

        <div className="mt-4 flex justify-end">
          <Button
            variant="danger"
            loading={signingOutAll}
            onClick={() => void handleSignOutEverywhere()}
          >
            Sign out everywhere
          </Button>
        </div>
      </Card>
    </div>
  )
}

/**
 * Window behaviour on this machine.
 *
 * A local, per-machine preference like the reminders below — it decides how the
 * app's own window sits on this desktop, nothing about the account.
 */
function WindowSettings(): React.JSX.Element {
  const { settings, updateSettings } = useSettings()

  if (!settings) return <Card title="Window">{null}</Card>

  return (
    <Card title="Window" description="How the app's window sits on this machine">
      <Toggle
        checked={settings.startup.showInTaskbar}
        onCheckedChange={(showInTaskbar) => updateSettings({ startup: { showInTaskbar } })}
        label="Show in taskbar"
        description="Adds a taskbar button for the window. The tray icon stays either way."
      />
    </Card>
  )
}


/**
 * When the Call Manager warns about an upcoming call.
 *
 * These are stored on this machine rather than with the account: the reminder
 * is something this computer pops up, and it has to keep working with no
 * network. Sign in on a second machine and each one keeps its own preference.
 */
function CallReminderSettings(): React.JSX.Element {
  const { settings, updateSettings } = useSettings()

  if (!settings) return <Card title="Call reminders">{null}</Card>

  const { notifications } = settings
  const patch = (change: Partial<typeof notifications>): void => {
    void updateSettings({ notifications: change })
  }

  const toggleLead = (minutes: number, on: boolean): void => {
    const next = on
      ? [...notifications.leadMinutes, minutes]
      : notifications.leadMinutes.filter((value) => value !== minutes)

    patch({ leadMinutes: [...new Set(next)].sort((a, b) => b - a) })
  }

  const noneChosen = notifications.enabled && notifications.leadMinutes.length === 0
  const noChannel =
    notifications.enabled &&
    !notifications.systemNotifications &&
    !notifications.inAppNotifications

  return (
    <Card title="Call reminders" description="Warnings before a scheduled call starts">
      <Toggle
        checked={notifications.enabled}
        onCheckedChange={(enabled) => patch({ enabled })}
        label="Remind me about upcoming calls"
        description="Applies to calls in the Call Manager. Nothing is announced while signed out."
      />

      <div
        className={cn(
          'mt-4 transition-opacity',
          !notifications.enabled && 'pointer-events-none opacity-40'
        )}
      >
        <p className="mb-2 text-xs font-medium text-muted">How much warning</p>

        <div className="flex flex-wrap gap-2">
          {REMINDER_LEAD_OPTIONS.map((minutes) => {
            const active = notifications.leadMinutes.includes(minutes)

            return (
              <button
                key={minutes}
                type="button"
                aria-pressed={active}
                onClick={() => toggleLead(minutes, !active)}
                className={cn(
                  'rounded-xl border px-3 py-1.5 text-xs font-medium transition-colors',
                  active
                    ? 'border-accent bg-accent/15 text-accent-strong'
                    : 'border-hairline bg-surface text-muted hover:text-ink'
                )}
              >
                {minutes === 0 ? 'At start time' : `${minutes} min before`}
              </button>
            )
          })}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-faint">
          One reminder fires for each option you pick, so all three means three warnings.
        </p>

        <div className="mt-4 border-t border-hairline pt-2">
          <Toggle
            checked={notifications.systemNotifications}
            onCheckedChange={(on) => patch({ systemNotifications: on })}
            label="Desktop notification"
            description="Shown by the operating system, so it reaches you with the window hidden in the tray."
          />
          <Toggle
            checked={notifications.inAppNotifications}
            onCheckedChange={(on) => patch({ inAppNotifications: on })}
            label="In-app message"
            description="A message inside this window. Only visible while the app is open in front of you."
          />
        </div>

        {noneChosen && (
          <Notice>
            No lead times are selected, so nothing will be announced. Pick at least one above.
          </Notice>
        )}

        {noChannel && (
          <Notice>
            Both delivery methods are off, so reminders have nowhere to appear.
          </Notice>
        )}
      </div>
    </Card>
  )
}

function Notice({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <p className="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
      {children}
    </p>
  )
}

/*
 * `PasswordField` and `FieldError` lived here for the password form, which has
 * gone to Nexus along with the password itself.
 */

/** Auth failures carry a message written for the user; anything else does not. */
function messageOf(error: unknown): string {
  return error instanceof AuthError ? error.message : 'Something went wrong. Please try again.'
}

/* -------------------------------------------------------------------------- */
/*                                   Profile                                  */
/* -------------------------------------------------------------------------- */

function Profile({
  name,
  email,
  id,
  role
}: {
  name: string
  email: string
  id: string
  role: UserRole
}): React.JSX.Element {
  return (
    <Card title="Profile" description="How this device knows you">
      <dl className="grid gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
        <Detail label="Name" value={name} />
        <Detail label="Email" value={email} />
        <Detail label="Account id" value={id} mono />

        <div className="min-w-0">
          <dt className="text-faint">Role</dt>
          <dd className="mt-0.5">
            <RoleBadge role={role} />
          </dd>
        </div>
      </dl>

      <p className="mt-5 text-xs leading-relaxed text-faint">
        Signing in is optional — recording, converting and the library all work without an
        account, and every file stays on this computer either way.
      </p>
    </Card>
  )
}

/**
 * Shows the account's role.
 *
 * Display only: what a role actually permits is enforced by the database, not
 * by anything this window decides to render.
 */
function RoleBadge({ role }: { role: UserRole }): React.JSX.Element {
  const superAdmin = role === 'super_admin'

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
        superAdmin
          ? 'border-accent/50 bg-accent/15 text-accent-strong'
          : 'border-hairline bg-surface text-muted'
      )}
    >
      {superAdmin ? 'Super admin' : 'User'}
    </span>
  )
}

function Detail({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <dt className="text-faint">{label}</dt>
      <dd
        className={cn('selectable mt-0.5 truncate text-ink', mono && 'font-mono text-[11px]')}
        title={value}
      >
        {value}
      </dd>
    </div>
  )
}
