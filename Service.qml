import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import "Parser.js" as Parser
import "Model.js" as Model
import "Store.js" as Store

// Overdue's service: owns every task, the nag scheduler and the IPC target.
// The bar widget, panel and quick-add overlay hold no data of their own; they
// bind to this object through the plugin's own-service facade
// (shell.serviceFor("canseyran.overdue")).
//
// Scheduling (NF-2): one Timer, armed for the next moment anything changes —
// a task falling due, a reminder repeating, a snooze or quiet hours ending, or
// midnight (when "today" rolls over). Every wake recomputes from the wall
// clock, so a late wake is harmless. Qt timers stop counting while the
// machine sleeps, so a logind PrepareForSleep watch re-checks on resume
// (NF-4).
//
// Plugins run inside the shell: every storage call is caught, so a bad row or
// a locked database logs a warning instead of taking the desktop down, and a
// failed save is reported to the user (see `problem`).
Item {
  id: root

  // Injected by the shell, so these must stay writable: it assigns each one
  // the service declares, and assigning a readonly property throws.
  property var shell: null
  property var manifest: null
  property string omarchyPath: Quickshell.env("OMARCHY_PATH") || "/usr/share/omarchy"

  readonly property string pluginId: (manifest && manifest.id) || Model.PLUGIN_ID
  readonly property string shellBin: omarchyPath + "/bin/omarchy-shell"
  readonly property string notifyBin: omarchyPath + "/bin/omarchy-notification-send"

  readonly property QtObject strings: Commons.Translations {
    directory: Qt.resolvedUrl("i18n")
  }
  // Dates follow the Omarchy language, not the locale the shell started with.
  readonly property var formatLocale: Qt.locale(Commons.I18n.formatLocale)

  // ------------------------------------------------------------------ state

  property var tasks: []
  property double now: Date.now()
  property var settings: Model.settingsWith({})
  property bool ready: false
  // Why the last storage write failed, or "" once one succeeds again.
  property string lastError: ""
  // The same, said to the user: "" when all is well.
  readonly property string problem: lastError === "" ? ""
    : /readonly database/i.test(lastError) ? strings.t("error.databaseMoved")
    : strings.t("error.storage").arg(lastError)
  // Midnight after the lifecycle (archive / delete old tasks) last ran; a
  // wake past it runs it again.
  property double maintainedDay: 0
  // Nags held back by quiet hours or a snooze right now.
  property int heldCount: 0
  // The daily review: when it last went out, and a "Later" that pushes it.
  property double reviewLastAt: 0
  property double reviewLaterUntil: 0
  // App-wide snooze: no reminders and no daily review until this moment
  // (ms, 0 when not snoozed). Survives a restart.
  property double snoozedUntil: 0
  readonly property bool snoozed: snoozedUntil > now

  readonly property var summary: Model.summary(tasks, now)
  readonly property var sections: Model.sections(tasks, now)

  // Notification ids from the daemon, so a repeat replaces the previous card
  // instead of stacking (NG-2): taskId -> id, and the daily review's card.
  property var notificationIds: ({})
  property int reviewNotificationId: 0

  // Bar widget instances (one per monitor) that can show the panel.
  property var panelHosts: []

  // -------------------------------------------------------------- lifecycle

  Component.onCompleted: {
    loadSettings()
    reload()
    root.ready = true
  }

  // Storage calls. Plugins run inside the shell, so a failure logs a warning
  // instead of throwing. Reads still work when writes do not (a database
  // deleted while open), so only writes set and clear lastError.

  // fn's result, or undefined when it failed.
  function read(what, fn) {
    try {
      return fn()
    } catch (e) {
      console.warn("overdue: " + what + " failed: " + e)
      return undefined
    }
  }

  // Whether fn ran without an error. A `sweep` (the lifecycle's bulk update,
  // which usually matches nothing) proves nothing about storage working, so
  // it does not clear an earlier failure.
  function write(what, fn, sweep) {
    try {
      fn()
      if (!sweep) root.lastError = ""
      return true
    } catch (e) {
      root.lastError = String(e)
      console.warn("overdue: " + what + " failed: " + e)
      return false
    }
  }

  function reload() {
    loadTasks()
    schedule()
  }

  function loadTasks() {
    var loadedAt = Date.now()
    write("maintain", function() {
      Store.maintain(loadedAt, root.settings.keepDoneDays, root.settings.keepArchivedDays)
    }, true)
    var all = read("load", function() { return Store.all() })
    if (all) root.tasks = all
    root.maintainedDay = Model.nextMidnight(loadedAt)
  }

  function loadSettings() {
    read("settings", function() {
      var raw = {}
      try { raw = JSON.parse(Store.getMeta("settings", "{}")) || {} } catch (e) { raw = {} }
      root.settings = Model.settingsWith(raw)
      root.reviewLastAt = Number(Store.getMeta("reviewLastAt", "0")) || 0
      root.reviewLaterUntil = Number(Store.getMeta("reviewLaterUntil", "0")) || 0
      root.snoozedUntil = Number(Store.getMeta("snoozedUntil", "0")) || 0
    })
  }

  // Merge settings from the bar widget (manifest schema), the settings view
  // or IPC. Unknown keys, such as the widget's "id", are ignored.
  function applySettings(values) {
    if (!values) return false
    var merged = {}
    for (var k in root.settings) merged[k] = root.settings[k]
    var touched = false
    for (var key in values) {
      if (!Model.isSetting(key) || values[key] === undefined || values[key] === null) continue
      merged[key] = values[key]
      touched = true
    }
    if (!touched) return false
    var next = Model.settingsWith(merged)
    if (JSON.stringify(next) === JSON.stringify(root.settings)) return false
    var keepChanged = next.keepDoneDays !== root.settings.keepDoneDays
      || next.keepArchivedDays !== root.settings.keepArchivedDays
    root.settings = next
    write("save settings", function() { Store.setMeta("settings", JSON.stringify(next)) })
    if (keepChanged) loadTasks()
    schedule()
    return true
  }

  function parserOptions() {
    return Model.parserOptions(root.settings)
  }

  function parse(text) {
    return Parser.parse(text, new Date(), parserOptions())
  }

  // ---------------------------------------------------------------- scheduler

  // Fire whatever is due, then arm the timer for the next moment.
  function schedule() {
    var wokeAt = Date.now()
    if (wokeAt >= root.maintainedDay) loadTasks()
    root.now = wokeAt
    var actions = plan(wokeAt)
    var fired = actions.review || actions.fire.length > 0 || actions.ahead.length > 0
    if (actions.review) review(wokeAt, false)
    if (actions.fire.length > 0 || actions.ahead.length > 0) {
      actions.ahead.concat(actions.fire).forEach(function(task) { nag(task, wokeAt) })
      loadTasks()
    }
    // What fired is marked as sent wokeAt; plan again for the actions moment.
    if (fired) actions = plan(wokeAt)
    root.heldCount = actions.held
    arm(actions.wakeAt)
  }

  function plan(at) {
    var reviewInfo = { lastAt: root.reviewLastAt, laterUntil: root.reviewLaterUntil }
    return Model.plan(root.tasks, at, root.settings, reviewInfo, root.snoozedUntil)
  }

  function arm(wakeAt) {
    var backstop = 3600000
    var delay = wakeAt === null || wakeAt === undefined ? backstop : wakeAt - Date.now()
    // At least a beat, so a moment that just passed is handled once, and at
    // most an hour as a backstop against wall-clock jumps nobody announced.
    wakeTimer.interval = Math.max(250, Math.min(backstop, Math.ceil(delay)))
    wakeTimer.restart()
  }

  Timer {
    id: wakeTimer
    repeat: false
    onTriggered: root.schedule()
  }

  // NF-4: logind announces sleep (true) and resume (false). One long-lived
  // monitor, read line by line: an event stream, not a poll.
  Process {
    id: sleepWatch
    property int failures: 0
    command: ["gdbus", "monitor", "--system", "--dest", "org.freedesktop.login1", "--object-path", "/org/freedesktop/login1"]
    running: true
    stdout: SplitParser {
      onRead: function(line) {
        if (line.indexOf("PrepareForSleep") === -1) return
        sleepWatch.failures = 0
        if (line.indexOf("false") !== -1) Qt.callLater(root.schedule)
      }
    }
    onExited: {
      sleepWatch.failures += 1
      // Back off from 30 s up to 30 min if gdbus is missing or keeps dying.
      sleepRestart.interval = Math.min(1800000, 30000 * Math.pow(2, Math.min(6, sleepWatch.failures - 1)))
      sleepRestart.restart()
    }
  }

  Timer {
    id: sleepRestart
    repeat: false
    onTriggered: {
      sleepWatch.running = true
      root.schedule()
    }
  }

  // ----------------------------------------------------------- notifications
  //
  // Every card is a normal notification under Overdue's own name, so
  // do-not-disturb silences it like any other app's. Text is neutralised
  // (NF-8) and every piece is its own argv word, so nothing is ever re-parsed
  // by a shell.

  // The start of an omarchy-notification-send command line. `replaces` is
  // the id of the card to replace, or 0.
  function notifyArgs(urgency, replaces) {
    var args = [root.notifyBin, "--app-name", Model.APP_NAME, "-u", urgency, "--transient"]
    if (replaces) args.push("-r", String(replaces))
    return args
  }

  // A button that runs `omarchy-shell <pluginId> <command> [arg]`.
  function pushAction(args, label, command, arg) {
    args.push("--action", label, root.shellBin, root.pluginId, command)
    if (arg !== undefined) args.push(String(arg))
  }

  // Runs the command; `posted(id)` gets the new card's id when the daemon
  // reports one.
  function runNotify(args, posted) {
    var proc = notifyComponent.createObject(root, { command: args, posted: posted || null })
    if (proc) proc.running = true
  }

  Component {
    id: notifyComponent

    Process {
      id: proc
      property var posted: null
      property bool exited: false
      property bool collected: false

      function finish() { if (proc.exited && proc.collected) proc.destroy() }

      stdout: StdioCollector {
        waitForEnd: true
        onStreamFinished: {
          var id = parseInt(String(text || "").trim(), 10)
          if (proc.posted && id > 0) proc.posted(id)
          proc.collected = true
          proc.finish()
        }
      }
      onExited: function(exitCode) {
        if (exitCode !== 0) console.warn("overdue: omarchy-notification-send exited with " + exitCode)
        proc.exited = true
        proc.finish()
      }
    }
  }

  function setNotificationId(taskId, id) {
    var next = {}
    for (var k in root.notificationIds) if (k !== String(taskId)) next[k] = root.notificationIds[k]
    if (id) next[String(taskId)] = id
    root.notificationIds = next
  }

  function nag(task, at) {
    write("nag", function() {
      Store.update(task.id, { nagCount: (task.nagCount || 0) + 1, lastNagAt: at })
    })
    var args = notifyArgs("normal", root.notificationIds[String(task.id)])
    args.push("-g", Model.REMINDER_GLYPH, "-p",
      Model.safeText(notificationTitle(task)), Model.safeText(notificationBody(task)))
    pushAction(args, root.strings.t("action.done"), "done", task.id)
    // Snooze is app-wide: this button holds every reminder, not just this one.
    var snoozeMin = root.settings.snoozeMin
    pushAction(args, root.strings.t("action.snooze").arg(Model.shortDuration(snoozeMin)), "snooze", snoozeMin)
    runNotify(args, function(id) { root.setNotificationId(task.id, id) })
  }

  // The card's headline: the task's title, or with titles hidden (for a
  // shared screen) "Task due" / "Task due soon".
  function notificationTitle(task) {
    if (!root.settings.hideTitles) return task.title
    return root.strings.t(task.dueAt !== null && task.dueAt > Date.now() ? "notify.hiddenSoon" : "notify.hiddenDue")
  }

  // "Today 09:00 · 20 min overdue", or ahead of time "Today 09:00 · in 10 min"
  function notificationBody(task) {
    var when = whenLabel(task.dueAt)
    var rel = shortRelativeLabel(task.dueAt)
    return rel ? root.strings.t("notify.body").arg(when).arg(rel) : when
  }

  // After a task is completed, deleted or rescheduled, its open card is
  // replaced by a short confirmation that times out, so it does not linger.
  function settleNotification(task, key) {
    var replaces = root.notificationIds[String(task.id)]
    if (!replaces) return
    setNotificationId(task.id, 0)
    var args = notifyArgs("low", replaces)
    args.push("-t", "2500",
      Model.safeText(root.settings.hideTitles ? root.strings.t("notify.hiddenTask") : task.title),
      Model.safeText(root.strings.t(key)))
    runNotify(args)
  }

  // Close every open reminder card: replaced in place by one that expires at
  // once (the daemon has no close-by-id for other senders).
  function closeReminders() {
    for (var k in root.notificationIds) {
      var args = notifyArgs("low", root.notificationIds[k])
      args.push("-t", "1", Model.APP_NAME, "")
      runNotify(args)
    }
    root.notificationIds = ({})
  }

  // ------------------------------------------------------------- operations

  function taskFor(id) {
    var taskId = Number(id)
    for (var i = 0; i < root.tasks.length; i++) if (root.tasks[i].id === taskId) return root.tasks[i]
    return read("get", function() { return Store.get(taskId) }) || null
  }

  function fieldsFromParse(parsed) {
    return {
      title: parsed.title,
      dueAt: parsed.dueAt,
      recur: Parser.recurToString(parsed.recur),
      tags: parsed.tags,
      priority: parsed.priority,
      description: parsed.description || ""
    }
  }

  // A task with a new due moment starts its reminders over.
  function withFreshNag(fields) {
    fields.nagCount = 0
    fields.lastNagAt = 0
    return fields
  }

  // Returns the new task id, or 0 when it could not be saved.
  function insertTask(fields) {
    fields.createdAt = Date.now()
    var id = 0
    write("add", function() { id = Store.insert(fields) })
    reload()
    return id
  }

  // Whether it was saved.
  function updateTask(task, fields, what) {
    if (fields.dueAt !== undefined && fields.dueAt !== task.dueAt) withFreshNag(fields)
    var saved = write(what, function() { Store.update(task.id, fields) })
    reload()
    return saved
  }

  // The operations below return whether they were done: false for an
  // unknown task, a line that was not understood, or a failed save (then
  // lastError says why).

  // Returns the new task id, or 0.
  function add(text) {
    var input = String(text || "").trim()
    if (!input) return 0
    return insertTask(fieldsFromParse(parse(input)))
  }

  function complete(id) {
    var task = taskFor(id)
    if (!task || task.doneAt || task.archivedAt) return false
    var completedAt = Date.now()
    var recur = Parser.recurFromString(task.recur)
    var saved = write("complete", function() {
      // A recurring task moves to its next occurrence instead of closing.
      if (recur && task.dueAt !== null)
        Store.update(task.id, withFreshNag({ dueAt: Parser.nextOccurrence(recur, task.dueAt, completedAt) }))
      else
        Store.update(task.id, { doneAt: completedAt })
    })
    if (saved) settleNotification(task, "notify.done")
    reload()
    return saved
  }

  // Back to Tasks, from Completed or Archived. Counted as already reminded
  // now, so the next reminder waits one interval.
  function restore(id) {
    var task = taskFor(id)
    if (!task || (!task.doneAt && !task.archivedAt)) return false
    return updateTask(task, { doneAt: null, archivedAt: null, nagCount: 0, lastNagAt: Date.now() }, "restore")
  }

  // To Archived, by hand: an open task you are dropping, or a completed one.
  function archive(id) {
    var task = taskFor(id)
    if (!task || task.archivedAt) return false
    var saved = write("archive", function() { Store.update(task.id, { archivedAt: Date.now() }) })
    if (saved) settleNotification(task, "notify.archived")
    reload()
    return saved
  }

  function remove(id) {
    var task = taskFor(id)
    if (!task) return false
    var saved = write("remove", function() { Store.remove(task.id) })
    if (saved) settleNotification(task, "notify.removed")
    reload()
    return saved
  }

  // App-wide snooze: hold every reminder and the daily review for `minutes`.
  // Open reminder cards are closed; the bar icon and the panel show the
  // snooze until it ends.
  function snoozeAll(minutes) {
    var duration = parseInt(minutes, 10)
    if (!(duration > 0)) duration = root.settings.snoozeMin
    duration = Math.min(duration, Model.SETTINGS.snoozeMin.max)
    root.snoozedUntil = Date.now() + duration * 60000
    // Held for this session even if it cannot be saved.
    var saved = write("snooze", function() { Store.setMeta("snoozedUntil", String(root.snoozedUntil)) })
    closeReminders()
    schedule()
    return saved
  }

  function resume() {
    root.snoozedUntil = 0
    var saved = write("resume", function() { Store.setMeta("snoozedUntil", "0") })
    schedule()
    return saved
  }

  // Re-parse an edited line (TL-2): title, date, tags and the rest.
  function edit(id, text) {
    var task = taskFor(id)
    var input = String(text || "").trim()
    if (!task || !input) return false
    return updateTask(task, fieldsFromParse(parse(input)), "edit")
  }

  // The edit form (and the panel's add form): three boxes.
  //   titleText  title with tags and priority. When adding, a
  //              whole quick-add line works here too (date, "--" description).
  //   dueText    the due date in words; empty means none. When it is empty
  //              and the Task box holds a date, that date is used.
  //   descText   the description as written.
  // id 0 adds a task. Returns "" when saved, which box was not understood
  // ("title" or "due"), or "storage" when saving failed.
  function saveForm(id, titleText, dueText, descText) {
    if (String(titleText || "").trim() === "") return "title"
    var title = parse(String(titleText))
    var fields = fieldsFromParse(title)
    var dueLine = String(dueText || "").trim()
    if (dueLine !== "") {
      var due = parse(dueLine)
      if (due.dueAt === null || due.rest !== "") return "due"
      fields.dueAt = due.dueAt
      fields.recur = Parser.recurToString(due.recur)
    }
    var desc = String(descText || "").replace(/\s+$/, "").replace(/^\s*\n/, "")
    if (desc !== "" || id) fields.description = desc !== "" ? desc : (title.description || "")
    if (!id) return insertTask(fields) ? "" : "storage"
    var task = taskFor(id)
    if (!task) return "title"
    return updateTask(task, fields, "edit") ? "" : "storage"
  }

  // Only the description; empty clears it. Taken as written, never parsed.
  function describe(id, text) {
    var task = taskFor(id)
    if (!task) return false
    return updateTask(task, { description: String(text || "").trim() }, "describe")
  }

  // Only the date: "tomorrow 9am", "in 2h", or "none" to clear it.
  function reschedule(id, text) {
    var task = taskFor(id)
    if (!task) return false
    var input = String(text || "").trim()
    var due = null
    if (input && input.toLowerCase() !== "none") {
      due = parse(input).dueAt
      if (due === null) return false
    }
    var saved = write("reschedule", function() { Store.update(task.id, withFreshNag({ dueAt: due })) })
    if (saved) settleNotification(task, "notify.rescheduled")
    reload()
    return saved
  }

  // ------------------------------------------------------------- formatting

  // A plural entry with its count filled in. Some forms carry no %1 ("every
  // month"), so this replaces rather than calling arg(), which warns.
  function plural(key, count) {
    return root.strings.tn(key, count).replace(/%1/g, Commons.I18n.formatNumber(count))
  }

  // "Today", "Tomorrow", "Yesterday", a weekday within the week (in
  // `nameFormat`), otherwise the date; "" for today when `bareToday`.
  function dayLabel(ms, nameFormat, bareToday) {
    var date = new Date(ms)
    var kind = Model.dayKind(ms, root.now)
    if (kind === "today") return bareToday ? "" : root.strings.t("day.today")
    if (kind === "tomorrow") return root.strings.t("day.tomorrow")
    if (kind === "yesterday") return root.strings.t("day.yesterday")
    if (kind === "week") return root.formatLocale.dayName(date.getDay(), nameFormat)
    var sameYear = date.getFullYear() === new Date(root.now).getFullYear()
    return date.toLocaleDateString(root.formatLocale, sameYear ? "d MMM" : "d MMM yyyy")
  }

  function timeLabel(ms) {
    return new Date(ms).toLocaleTimeString(root.formatLocale, Locale.ShortFormat)
  }

  // "Today 09:00", "Friday 09:00", "25 Dec 09:00".
  function whenLabel(ms) {
    if (ms === null || ms === undefined) return ""
    return root.strings.t("when.dayTime").arg(dayLabel(ms, Locale.LongFormat, false)).arg(timeLabel(ms))
  }

  // For list rows: the time alone today (the group already says "Today"), a
  // short weekday within the week, otherwise the date.
  //   "09:00", "Tomorrow 09:00", "Fri 09:00", "25 Dec 09:00"
  function shortWhen(ms) {
    if (ms === null || ms === undefined) return ""
    var day = dayLabel(ms, Locale.ShortFormat, true)
    return day === "" ? timeLabel(ms) : root.strings.t("when.dayTime").arg(day).arg(timeLabel(ms))
  }

  // "in 2 h", "20 min overdue", "now".
  function shortRelativeLabel(ms) {
    if (ms === null || ms === undefined) return ""
    var relative = Model.shortRelative(ms, root.now)
    if (!relative) return root.strings.t("due.now")
    return root.strings.t(relative.future ? "rel.in" : "rel.overdue").arg(relative.span)
  }

  function relativeLabel(ms) {
    var relative = Model.relativeDue(ms, root.now)
    if (relative.key === "due.none" || relative.key === "due.now" || relative.key === "due.inUnderMinute") return root.strings.t(relative.key)
    return plural(relative.key, relative.count)
  }

  function recurLabel(recurText) {
    var recur = typeof recurText === "string" ? Parser.recurFromString(recurText) : recurText
    if (!recur) return ""
    if (recur.unit === "weekday") return root.strings.t("recur.weekday")
    if (recur.unit === "week" && recur.weekday !== undefined)
      return root.strings.t("recur.weekOn").arg(root.formatLocale.dayName(recur.weekday, Locale.LongFormat))
    return plural("recur." + recur.unit, recur.every)
  }

  // What the quick-add line will save, for its live preview (QA-4).
  function preview(text) {
    var input = String(text || "").trim()
    if (!input) return null
    var parsed = parse(input)
    return {
      title: parsed.title,
      when: parsed.dueAt === null ? "" : whenLabel(parsed.dueAt),
      relative: parsed.dueAt === null ? "" : relativeLabel(parsed.dueAt),
      recur: recurLabel(parsed.recur),
      tags: parsed.tags,
      priority: parsed.priority,
      description: parsed.description || ""
    }
  }

  // --------------------------------------------------------------- panel

  function registerPanelHost(host) {
    if (!host || root.panelHosts.indexOf(host) !== -1) return
    root.panelHosts = root.panelHosts.concat([host])
  }

  function unregisterPanelHost(host) {
    root.panelHosts = root.panelHosts.filter(function(other) { return other !== host })
  }

  // The widget on the focused monitor; any widget if none is; null without
  // a bar widget.
  function panelHost() {
    var hosts = root.panelHosts
    for (var i = 0; i < hosts.length; i++)
      if (hosts[i] && typeof hosts[i].onFocusedMonitor === "function" && hosts[i].onFocusedMonitor()) return hosts[i]
    return hosts.length > 0 ? hosts[0] : null
  }

  function togglePanel() {
    var host = panelHost()
    if (host) host.togglePanel()
    return !!host
  }

  // Opens (never closes) the panel: what the daily review's button does.
  function showPanel() {
    var host = panelHost()
    if (host && !host.opened) host.open()
    return !!host
  }

  function quickAdd() {
    return root.shell && typeof root.shell.summon === "function" ? root.shell.summon(root.pluginId, "{}") : false
  }

  // ----------------------------------------------------------------- review

  function saveReview() {
    write("save review", function() {
      Store.setMeta("reviewLastAt", String(root.reviewLastAt))
      Store.setMeta("reviewLaterUntil", String(root.reviewLaterUntil))
    })
  }

  // The daily review: one notification that sums up what is open, naming
  // the tasks with no due date, since nothing else reminds you of those.
  //   "2 overdue · 1 due today · 5 with no due date (Pay rent, Call bank,
  //    Renew passport and 2 more)"
  // With nothing open it is skipped quietly. `force` sends it anyway (IPC).
  function review(at, force) {
    root.reviewLastAt = at
    root.reviewLaterUntil = 0
    saveReview()
    var counts = Model.reviewSummary(root.tasks, at)
    if (counts.open === 0 && !force) return false

    var args = notifyArgs("normal", root.reviewNotificationId)
    args.push("-g", Model.REVIEW_GLYPH, "-p",
      Model.safeText(root.strings.t("review.title")), Model.safeText(reviewBody(counts)))
    pushAction(args, root.strings.t("review.open"), "openPanel")
    pushAction(args, root.strings.t("review.later").arg(Model.shortDuration(root.settings.snoozeMin)), "reviewLater")
    runNotify(args, function(id) { root.reviewNotificationId = id })
    return true
  }

  function reviewBody(counts) {
    var parts = []
    if (counts.overdue > 0) parts.push(plural("review.overdue", counts.overdue))
    if (counts.today > 0) parts.push(plural("review.today", counts.today))
    if (counts.upcoming > 0) parts.push(plural("review.upcoming", counts.upcoming))
    if (counts.nodate > 0) {
      var nodate = plural("review.nodate", counts.nodate)
      // Named, unless titles are hidden; then counts only.
      if (!root.settings.hideTitles) {
        var names = counts.undatedTitles.join(", ")
        var rest = counts.nodate - counts.undatedTitles.length
        if (rest > 0) names += " " + plural("review.more", rest)
        nodate += " (" + names + ")"
      }
      parts.push(nodate)
    }
    return parts.length > 0 ? parts.join(" · ") : root.strings.t("widget.idle")
  }

  function reviewLater() {
    root.reviewLaterUntil = Date.now() + root.settings.snoozeMin * 60000
    // Undo today's "sent" so the later moment still counts as due.
    root.reviewLastAt = 0
    saveReview()
    schedule()
    return true
  }

  // --------------------------------------------------------------------- IPC

  function isoOrNull(ms) {
    return ms ? new Date(ms).toISOString() : null
  }

  function taskJson(task) {
    return {
      id: task.id,
      title: task.title,
      due: task.dueAt === null ? null : new Date(task.dueAt).toISOString(),
      recur: task.recur,
      tags: task.tags,
      priority: task.priority,
      nagCount: task.nagCount,
      created: new Date(task.createdAt).toISOString(),
      done: isoOrNull(task.doneAt),
      archived: isoOrNull(task.archivedAt),
      description: task.description || "",
      overdue: Model.isOverdue(task, Date.now())
    }
  }

  // An IPC answer: "ok", or why not.
  function ipcReply(id, done) {
    if (done) return "ok"
    if (!taskFor(id)) return "unknown task"
    return root.lastError !== "" ? "error: " + root.lastError : "not done"
  }

  // QML method names cannot be JavaScript reserved words, so "export" is
  // exportJson.
  ShellIpc {
    target: root.pluginId

    // omarchy-shell canseyran.overdue add "call mom tomorrow 3pm"
    function add(text: string): string {
      if (String(text || "").trim() === "") return "error: nothing to add"
      var id = root.add(text)
      if (!id) return "error: " + root.lastError
      var task = root.taskFor(id)
      return task ? JSON.stringify(root.taskJson(task)) : String(id)
    }

    function done(id: string): string { return root.ipcReply(id, root.complete(id)) }
    // App-wide: no reminders for this many minutes.
    function snooze(minutes: string): string {
      var saved = root.snoozeAll(minutes)
      var until = new Date(root.snoozedUntil).toISOString()
      // Still held until then, but only until the shell restarts.
      return saved ? until : until + " (not saved: " + root.lastError + ")"
    }
    function resume(): string { return root.resume() ? "ok" : "error: " + root.lastError }
    function restore(id: string): string { return root.ipcReply(id, root.restore(id)) }
    function archive(id: string): string { return root.ipcReply(id, root.archive(id)) }
    function remove(id: string): string { return root.ipcReply(id, root.remove(id)) }
    function edit(id: string, text: string): string {
      if (String(text || "").trim() === "") return "error: nothing to save"
      return root.ipcReply(id, root.edit(id, text))
    }
    function describe(id: string, text: string): string { return root.ipcReply(id, root.describe(id, text)) }
    function reschedule(id: string, when: string): string {
      var input = String(when || "").trim()
      if (input !== "" && input.toLowerCase() !== "none" && root.parse(input).dueAt === null) return "not understood"
      return root.ipcReply(id, root.reschedule(id, when))
    }

    // Open tasks in panel order.
    function list(): string {
      return JSON.stringify(Model.ordered(root.tasks, Date.now()).map(root.taskJson), null, 2)
    }

    // NF-3 backup: every task, done ones included, plus settings.
    function exportJson(): string {
      var all = root.read("export", function() { return Store.all() }) || []
      return JSON.stringify({
        app: root.pluginId,
        version: root.manifest ? root.manifest.version : "",
        exportedAt: new Date().toISOString(),
        settings: root.settings,
        tasks: all.map(root.taskJson)
      }, null, 2)
    }

    // What the parser makes of a line, without saving it.
    function parse(text: string): string {
      return JSON.stringify(root.preview(text) || {}, null, 2)
    }

    function settings(): string { return JSON.stringify(root.settings, null, 2) }

    function setSetting(key: string, value: string): string {
      if (!Model.isSetting(key)) return "unknown setting"
      var change = {}
      change[key] = value
      root.applySettings(change)
      return JSON.stringify(root.settings, null, 2)
    }

    function refresh(): string { root.reload(); return "ok" }
    function togglePanel(): string { return root.togglePanel() ? "ok" : "no bar widget" }
    function openPanel(): string { return root.showPanel() ? "ok" : "no bar widget" }
    // The daily review now, whatever the time (also when nothing is open).
    function review(): string { root.review(Date.now(), true); root.schedule(); return "ok" }
    function reviewLater(): string { root.reviewLater(); return "ok" }
    function quickAdd(): string { return root.quickAdd() ? "ok" : "unavailable" }

    function status(): string {
      return JSON.stringify({
        state: root.summary.state,
        overdue: root.summary.overdue,
        today: root.summary.today,
        held: root.heldCount,
        snoozedUntil: root.snoozed ? new Date(root.snoozedUntil).toISOString() : null,
        openNotifications: Object.keys(root.notificationIds).length,
        nextWakeMs: wakeTimer.running ? wakeTimer.interval : null,
        lastError: root.lastError
      })
    }

    function ping(): string { return "ok" }
  }
}
