.pragma library

// Pure task logic shared by the service, the bar widget and the panel: which
// section a task sits in, when the next nag is due, quiet hours, and making
// task text safe to hand to the notification daemon. No QML imports, so the
// tests load it under Node or Bun (see tests/load.js).
//
// A task here is the plain object Store.js returns:
//   { id, title, dueAt (ms|null), recur (string), tags ([]), priority (0-3),
//     description, nagCount, lastNagAt (ms, 0 = never), createdAt,
//     doneAt (ms|null), archivedAt (ms|null) }

var PLUGIN_ID = "canseyran.overdue"
var APP_NAME = "Overdue"

var MINUTE = 60000
var HOUR = 3600000
var DAY = 86400000

// ---------------------------------------------------------------- settings
//
// Every setting, its default and how a raw value (from shell.json, the
// settings view or IPC, so possibly a string) is read. manifest.json's widget
// schema mirrors this table; tests/manifest.test.js keeps the two in step.
//   int    clamped to [min, max]; not a number keeps the default
//   bool   true or "true"
//   enum   one of `options`; anything else is the first option
//   clock  "HH:MM" or "" (off); a typo keeps the default
//   range  "HH:MM-HH:MM" or "" (none)
var SETTINGS = {
  // Reminders
  nagEveryMin: { type: "int", min: 1, max: 1440, value: 10 },
  // An extra reminder this many minutes before a task is due (0 = none).
  remindAheadMin: { type: "int", min: 0, max: 1440, value: 0 },
  // Snooze is app-wide: it holds every reminder and the daily review.
  snoozeMin: { type: "int", min: 1, max: 10080, value: 30 },
  // Reminders say "Task due" instead of the task's title.
  hideTitles: { type: "bool", value: false },
  reviewTime: { type: "clock", value: "09:00" },
  quietHours: { type: "range", value: "" },

  // Dates: hours the parser gives "tomorrow" (no time) and the day parts.
  defaultHour: { type: "int", min: 0, max: 23, value: 9 },
  morningHour: { type: "int", min: 0, max: 23, value: 9 },
  afternoonHour: { type: "int", min: 0, max: 23, value: 14 },
  eveningHour: { type: "int", min: 0, max: 23, value: 18 },
  nightHour: { type: "int", min: 0, max: 23, value: 21 },
  // "at 1" to "at 6" mean the afternoon.
  bareHoursPm: { type: "bool", value: true },
  weekStart: { type: "enum", options: ["monday", "sunday"], value: "monday" },
  // "friday", or "last" (the week's last day).
  endOfWeek: { type: "enum", options: ["friday", "last"], value: "friday" },

  // Lists: Today / Upcoming / No due date groups, or one list by due date.
  groupTasks: { type: "bool", value: true },
  // Completed tasks move to Archived after this many days, and archived
  // tasks are deleted after keepArchivedDays (0 = never, for both).
  keepDoneDays: { type: "int", min: 0, max: 3650, value: 7 },
  keepArchivedDays: { type: "int", min: 0, max: 3650, value: 30 },

  // Bar
  showCount: { type: "bool", value: true }
}

var SETTING_DEFAULTS = (function() {
  var out = {}
  for (var key in SETTINGS) out[key] = SETTINGS[key].value
  return out
})()

// The settings the date parser reads (see Parser.DEFAULTS).
var PARSER_KEYS = ["defaultHour", "morningHour", "afternoonHour", "eveningHour", "nightHour",
  "bareHoursPm", "weekStart", "endOfWeek"]

function isSetting(key) {
  return Object.prototype.hasOwnProperty.call(SETTINGS, key)
}

// The defaults with every known key of `raw` read in. Unknown keys are
// dropped.
function settingsWith(raw) {
  var out = {}
  for (var key in SETTINGS) {
    var value = raw ? raw[key] : undefined
    out[key] = value === undefined || value === null ? SETTINGS[key].value : readSetting(SETTINGS[key], value)
  }
  return out
}

function readSetting(spec, value) {
  if (spec.type === "int") return clampInt(value, spec.min, spec.max, spec.value)
  if (spec.type === "bool") return value === true || value === "true"
  if (spec.type === "enum") {
    var option = String(value).toLowerCase()
    return spec.options.indexOf(option) !== -1 ? option : spec.options[0]
  }
  var text = String(value).trim()
  if (spec.type === "range") return parseQuietHours(text) ? text : ""
  // clock: only an empty value turns it off, so a typo does not.
  if (text === "") return ""
  var minutes = parseClock(text)
  return minutes !== null ? formatClock(minutes) : spec.value
}

function parserOptions(settings) {
  var all = settingsWith(settings)
  var out = {}
  for (var i = 0; i < PARSER_KEYS.length; i++) out[PARSER_KEYS[i]] = all[PARSER_KEYS[i]]
  return out
}

function clampInt(value, min, max, fallback) {
  var number = parseInt(value, 10)
  if (!isFinite(number)) return fallback
  return Math.max(min, Math.min(max, number))
}

function startOfDay(ms) {
  var date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

function nextMidnight(ms) {
  var date = new Date(ms)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime()
}

function isOpen(task) {
  return !!task && !task.doneAt && !task.archivedAt
}

function hasDue(task) {
  return task.dueAt !== null && task.dueAt !== undefined
}

function isOverdue(task, now) {
  return isOpen(task) && hasDue(task) && task.dueAt <= now
}

function isDueToday(task, now) {
  return isOpen(task) && hasDue(task) && task.dueAt > now && task.dueAt < nextMidnight(now)
}

// Overdue / Today / Upcoming / No date, each sorted. Overdue and dated
// sections sort by due time, then priority; undated by priority, then age.
function sections(tasks, now) {
  var out = { overdue: [], today: [], upcoming: [], nodate: [], done: [], archived: [] }
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i]
    if (!task) continue
    if (task.archivedAt) out.archived.push(task)
    else if (task.doneAt) out.done.push(task)
    else if (!hasDue(task)) out.nodate.push(task)
    else if (task.dueAt <= now) out.overdue.push(task)
    else if (task.dueAt < nextMidnight(now)) out.today.push(task)
    else out.upcoming.push(task)
  }
  var byDue = function(a, b) { return (a.dueAt - b.dueAt) || priorityRank(a) - priorityRank(b) || a.id - b.id }
  out.overdue.sort(byDue)
  out.today.sort(byDue)
  out.upcoming.sort(byDue)
  out.nodate.sort(function(a, b) { return priorityRank(a) - priorityRank(b) || a.createdAt - b.createdAt || a.id - b.id })
  out.done.sort(function(a, b) { return b.doneAt - a.doneAt || b.id - a.id })
  out.archived.sort(function(a, b) { return b.archivedAt - a.archivedAt || b.id - a.id })
  return out
}

// The groups the Tasks tab shows. Grouped: Today (overdue first, then due
// today), Upcoming, No due date; empty groups are left out. Ungrouped: one
// list by due date, undated last.
//   -> [{ key, tasks }]
function taskGroups(tasks, now, grouped) {
  var bySection = sections(tasks, now)
  if (!grouped) {
    var all = openInOrder(bySection)
    return all.length > 0 ? [{ key: "all", tasks: all }] : []
  }
  var groups = [
    { key: "today", tasks: bySection.overdue.concat(bySection.today) },
    { key: "upcoming", tasks: bySection.upcoming },
    { key: "nodate", tasks: bySection.nodate }
  ]
  return groups.filter(function(group) { return group.tasks.length > 0 })
}

// !1 first, no priority last.
function priorityRank(task) {
  var priority = task && task.priority ? task.priority : 0
  return priority > 0 ? priority : 4
}

// The open tasks of sections() in panel order: overdue, today, upcoming,
// no date.
function openInOrder(bySection) {
  return bySection.overdue.concat(bySection.today, bySection.upcoming, bySection.nodate)
}

function ordered(tasks, now) {
  return openInOrder(sections(tasks, now))
}

function filterTasks(tasks, query) {
  var needle = String(query || "").trim().toLowerCase()
  if (!needle) return tasks
  var words = needle.split(/\s+/)
  return tasks.filter(function(task) {
    var hay = (String(task.title || "") + " " + String(task.description || "") + " "
      + (task.tags || []).map(function(tag) { return "#" + tag }).join(" ")).toLowerCase()
    for (var i = 0; i < words.length; i++) if (hay.indexOf(words[i]) === -1) return false
    return true
  })
}

// Counts the bar widget shows.
function summary(tasks, now) {
  var overdue = 0
  var today = 0
  for (var i = 0; i < tasks.length; i++) {
    if (isOverdue(tasks[i], now)) overdue += 1
    else if (isDueToday(tasks[i], now)) today += 1
  }
  return {
    overdue: overdue,
    today: today,
    state: overdue > 0 ? "overdue" : today > 0 ? "today" : "idle"
  }
}

// "9", "09:00", "9:30" -> minutes after midnight, or null.
function parseClock(text) {
  var match = /^\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(text || ""))
  if (!match) return null
  var hour = parseInt(match[1], 10), minute = match[2] ? parseInt(match[2], 10) : 0
  if (hour > 23 || minute > 59) return null
  return hour * 60 + minute
}

function formatClock(minutes) {
  var hours = Math.floor(minutes / 60), rest = minutes % 60
  return (hours < 10 ? "0" : "") + hours + ":" + (rest < 10 ? "0" : "") + rest
}

// "15 min", "1 h", "1 h 30 min": snooze lengths on buttons.
function shortDuration(minutes) {
  var hours = Math.floor(minutes / 60), rest = minutes % 60
  if (hours === 0) return rest + " min"
  return rest === 0 ? hours + " h" : hours + " h " + rest + " min"
}

// The first few repeat times for a task due at `startMinutes` (minutes after
// midnight): "09:00, 09:10, 09:20". For the settings example.
function repeatExample(startMinutes, everyMin, count) {
  var out = []
  for (var i = 0; i < (count || 3); i++) {
    var minuteOfDay = (startMinutes + i * everyMin) % 1440
    out.push(formatClock(minuteOfDay))
  }
  return out.join(", ")
}

// -------------------------------------------------------------- review

// The daily review: when it is next due, and whether that is now.
//   review = { lastAt: ms, laterUntil: ms }  (both 0 when never)
//   -> { fire: true } | { fire: false, wakeAt: ms } | null (switched off)
function reviewState(now, settings, review) {
  var all = settingsWith(settings)
  var reviewMinute = parseClock(all.reviewTime)
  if (reviewMinute === null) return null
  var date = new Date(now)
  var today = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(reviewMinute / 60), reviewMinute % 60).getTime()
  var lastAt = review && review.lastAt ? review.lastAt : 0
  var due = lastAt >= today
    ? new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, Math.floor(reviewMinute / 60), reviewMinute % 60).getTime()
    : today
  if (review && review.laterUntil > lastAt) due = Math.max(due, review.laterUntil)
  if (now >= due) return { fire: true }
  return { fire: false, wakeAt: due }
}

// What the daily review reports: counts of open tasks by kind and the first
// few titles without a due date. Nothing to report when no task is open.
function reviewSummary(tasks, now) {
  var bySection = sections(tasks, now)
  return {
    overdue: bySection.overdue.length,
    today: bySection.today.length,
    nodate: bySection.nodate.length,
    upcoming: bySection.upcoming.length,
    open: openInOrder(bySection).length,
    undatedTitles: bySection.nodate.slice(0, 3).map(function(task) { return task.title })
  }
}

// -------------------------------------------------------------- quiet hours

// "22:00-08:00" -> { start: 1320, end: 480 } in minutes after midnight.
function parseQuietHours(text) {
  var match = /^\s*(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?\s*$/.exec(String(text || ""))
  if (!match) return null
  var startHour = parseInt(match[1], 10), startMinute = match[2] ? parseInt(match[2], 10) : 0
  var endHour = parseInt(match[3], 10), endMinute = match[4] ? parseInt(match[4], 10) : 0
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) return null
  var start = startHour * 60 + startMinute
  var end = endHour * 60 + endMinute
  if (start === end) return null
  return { start: start, end: end }
}

function minuteOfDay(ms) {
  var date = new Date(ms)
  return date.getHours() * 60 + date.getMinutes()
}

function inQuietHours(now, quiet) {
  if (!quiet) return false
  var minute = minuteOfDay(now)
  if (quiet.start < quiet.end) return minute >= quiet.start && minute < quiet.end
  return minute >= quiet.start || minute < quiet.end
}

// The wall-clock moment the current quiet window ends.
function quietEndAfter(now, quiet) {
  var date = new Date(now)
  var end = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(quiet.end / 60), quiet.end % 60)
  if (end.getTime() <= now) end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1, Math.floor(quiet.end / 60), quiet.end % 60)
  return end.getTime()
}

// -------------------------------------------------------------- nag planner

// An early reminder goes out only on time: within this long of its moment.
// When a task is added or rescheduled inside the lead window (or a wake comes
// late), it is skipped; the reminder at the due time still comes.
var AHEAD_SLACK = 30000

// When a task next wants attention, and whether that is now.
//   { fire: true, ahead: true }    the early reminder is due now
//   { fire: true }                 a nag is due now
//   { fire: false, wakeAt: ms }    nothing yet; look again at wakeAt
//   null                           nothing more to do for this task
function nagState(task, now, settings) {
  if (!isOpen(task) || !hasDue(task)) return null
  var all = settingsWith(settings)
  var due = task.dueAt
  if (now < due) {
    var lead = (all.remindAheadMin || 0) * MINUTE
    var aheadAt = due - lead
    // lastNagAt at or after aheadAt: the early reminder already went out.
    if (lead > 0 && (task.lastNagAt || 0) < aheadAt) {
      if (now < aheadAt) return { fire: false, wakeAt: aheadAt }
      if (now - aheadAt <= AHEAD_SLACK) return { fire: true, ahead: true }
    }
    return { fire: false, wakeAt: due }
  }

  var last = task.lastNagAt || 0
  // Never reminded since it fell due.
  if (last < due) return { fire: true }
  var every = all.nagEveryMin * MINUTE
  var next = last + every
  if (now >= next) return { fire: true }
  return { fire: false, wakeAt: next }
}

// What to do now across all tasks, and when to look again. Quiet hours (NG-6)
// and an app-wide snooze both hold every reminder and the daily review until
// they end; the bar still updates on time, so a task's due moment and the
// next midnight are wake points too.
//   snoozedUntil: ms, 0 when not snoozed
//   -> { fire: [task, ...], ahead: [task, ...], review: bool, wakeAt: ms|null, held: n }
function plan(tasks, now, settings, review, snoozedUntil) {
  var all = settingsWith(settings)
  var quiet = parseQuietHours(all.quietHours)
  var inQuiet = inQuietHours(now, quiet)
  var snoozed = snoozedUntil > now
  var quietNow = inQuiet || snoozed
  var fire = []
  var ahead = []
  var held = 0
  var wakeAt = nextMidnight(now)

  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i]
    if (!isOpen(task)) continue
    if (hasDue(task) && task.dueAt > now) wakeAt = Math.min(wakeAt, task.dueAt)
    var state = nagState(task, now, all)
    if (!state) continue
    if (state.fire) {
      if (quietNow) held += 1
      else if (state.ahead) ahead.push(task)
      else fire.push(task)
    } else {
      wakeAt = Math.min(wakeAt, state.wakeAt)
    }
  }
  var reviewNow = false
  var reviewDue = reviewState(now, all, review)
  if (reviewDue && reviewDue.fire) {
    if (quietNow) held += 1
    else reviewNow = true
  } else if (reviewDue) {
    wakeAt = Math.min(wakeAt, reviewDue.wakeAt)
  }

  if (quietNow) {
    var holdEnd = Math.max(inQuiet ? quietEndAfter(now, quiet) : 0, snoozed ? snoozedUntil : 0)
    wakeAt = Math.min(wakeAt, holdEnd)
  }
  return { fire: fire, ahead: ahead, review: reviewNow, wakeAt: wakeAt, held: held }
}

// ------------------------------------------------------------ text safety

// Task text goes to the notification daemon, which may render markup, and
// through omarchy-notification-send, which reads a leading dash as an option.
// Escape the markup characters, flatten control characters and newlines, cap
// the length, and put a word joiner in front of a leading dash.
function safeText(value, maxLength) {
  var text = String(value === undefined || value === null ? "" : value)
  text = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\text+/g, " ").trim()
  var limit = maxLength || 200
  if (text.length > limit) text = text.slice(0, limit - 1) + "…"
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  if (text.charAt(0) === "-") text = "⁠" + text
  return text
}

// ------------------------------------------------------------- formatting

// A relative description of a due moment, as a key and a count, so the
// caller translates it: { key: "due.inMinutes", count: 20 }.
function relativeDue(dueAt, now) {
  if (dueAt === null || dueAt === undefined) return { key: "due.none", count: 0 }
  var diff = dueAt - now
  var distance = Math.abs(diff)
  if (distance < MINUTE) return { key: diff <= 0 ? "due.now" : "due.inUnderMinute", count: 0 }
  if (distance < HOUR) return { key: diff < 0 ? "due.minutesAgo" : "due.inMinutes", count: Math.round(distance / MINUTE) }
  if (distance < DAY) return { key: diff < 0 ? "due.hoursAgo" : "due.inHours", count: Math.round(distance / HOUR) }
  var days = Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)
  return { key: days < 0 ? "due.daysAgo" : "due.inDays", count: Math.abs(days) }
}

// A compact distance for list rows: { future, span } with span "20 min",
// "2 h" or "3 d" (calendar days once it is a day or more away), or null
// within a minute of now.
function shortRelative(dueAt, now) {
  if (dueAt === null || dueAt === undefined) return null
  var diff = dueAt - now
  var distance = Math.abs(diff)
  if (distance < MINUTE) return null
  var span
  if (distance < HOUR) span = Math.round(distance / MINUTE) + " min"
  else if (distance < DAY) span = Math.round(distance / HOUR) + " h"
  else span = Math.abs(Math.round((startOfDay(dueAt) - startOfDay(now)) / DAY)) + " d"
  return { future: diff > 0, span: span }
}

// Which day a moment falls on relative to now: "today", "tomorrow",
// "yesterday", "week" (within the next 6 days) or "date".
function dayKind(ms, now) {
  var days = Math.round((startOfDay(ms) - startOfDay(now)) / DAY)
  if (days === 0) return "today"
  if (days === 1) return "tomorrow"
  if (days === -1) return "yesterday"
  if (days > 1 && days < 7) return "week"
  return "date"
}

// Notification glyphs (Material Design Icons in the Nerd Font), distinct from
// a generic bell so a card reads as a task at a glance.
var REMINDER_GLYPH = String.fromCodePoint(0xF18F9) // clipboard-text-clock
var REVIEW_GLYPH = String.fromCodePoint(0xF0756)   // format-list-checks

// A glyph per bar state, one clipboard family so the bar icon reads as tasks
// (Material Design Icons in the Nerd Font).
function stateGlyph(state, snoozed) {
  if (snoozed) return String.fromCodePoint(0xF161B)              // clipboard-off-outline
  if (state === "overdue") return String.fromCodePoint(0xF0CF7) // clipboard-alert-outline
  if (state === "today") return String.fromCodePoint(0xF18FA)   // clipboard-text-clock-outline
  return String.fromCodePoint(0xF08A8)                          // clipboard-check-outline
}

// Node/Bun test hook; QML never sees `module`.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    PLUGIN_ID: PLUGIN_ID, SETTINGS: SETTINGS, SETTING_DEFAULTS: SETTING_DEFAULTS, PARSER_KEYS: PARSER_KEYS,
    isSetting: isSetting, settingsWith: settingsWith, parserOptions: parserOptions,
    nextMidnight: nextMidnight, isOverdue: isOverdue, isDueToday: isDueToday,
    sections: sections, taskGroups: taskGroups, ordered: ordered, filterTasks: filterTasks, summary: summary,
    parseClock: parseClock, formatClock: formatClock, shortDuration: shortDuration, repeatExample: repeatExample,
    reviewState: reviewState, reviewSummary: reviewSummary,
    parseQuietHours: parseQuietHours, inQuietHours: inQuietHours, quietEndAfter: quietEndAfter,
    nagState: nagState, plan: plan, safeText: safeText,
    relativeDue: relativeDue, shortRelative: shortRelative, dayKind: dayKind, stateGlyph: stateGlyph,
    REMINDER_GLYPH: REMINDER_GLYPH, REVIEW_GLYPH: REVIEW_GLYPH
  }
}
