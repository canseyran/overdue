"use strict"
const test = require("node:test")
const assert = require("node:assert/strict")
const M = require("./load")("Model.js")

const NOW = new Date(2026, 10, 25, 10, 0).getTime()
const MIN = 60000
const at = (y, m, d, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime()

let nextId = 1
function task(fields) {
  return Object.assign({
    id: nextId++, title: "t", dueAt: null, recur: "", tags: [], priority: 0,
    nagCount: 0, lastNagAt: 0,
    createdAt: 0, doneAt: null, archivedAt: null
  }, fields)
}

test("sections sort tasks into overdue, today, upcoming and no date", () => {
  const s = M.sections([
    task({ title: "late", dueAt: NOW - MIN }),
    task({ title: "later today", dueAt: at(2026, 11, 25, 18) }),
    task({ title: "tomorrow", dueAt: at(2026, 11, 26) }),
    task({ title: "someday" }),
    task({ title: "finished", dueAt: NOW - MIN, doneAt: NOW })
  ], NOW)
  assert.deepEqual(s.overdue.map(t => t.title), ["late"])
  assert.deepEqual(s.today.map(t => t.title), ["later today"])
  assert.deepEqual(s.upcoming.map(t => t.title), ["tomorrow"])
  assert.deepEqual(s.nodate.map(t => t.title), ["someday"])
  assert.deepEqual(s.done.map(t => t.title), ["finished"])
})

test("summary drives the bar state", () => {
  assert.equal(M.summary([], NOW).state, "idle")
  assert.equal(M.summary([task({ dueAt: NOW + 3600000 })], NOW).state, "today")
  const s = M.summary([task({ dueAt: NOW - MIN }), task({ dueAt: NOW + MIN })], NOW)
  assert.equal(s.state, "overdue")
  assert.equal(s.overdue, 1)
  assert.equal(s.today, 1)
})

test("NG-1: a task nags the moment it falls due", () => {
  const t = task({ dueAt: NOW + 5 * MIN })
  assert.deepEqual(M.nagState(t, NOW, { remindAheadMin: 0 }), { fire: false, wakeAt: NOW + 5 * MIN })
  assert.deepEqual(M.nagState(t, NOW + 5 * MIN, {}), { fire: true })
})

test("NG-2: nags repeat every N minutes until done", () => {
  const t = task({ dueAt: NOW - 30 * MIN, lastNagAt: NOW - 4 * MIN, nagCount: 1 })
  assert.deepEqual(M.nagState(t, NOW, {}), { fire: false, wakeAt: NOW + 6 * MIN })
  assert.deepEqual(M.nagState(t, NOW, { nagEveryMin: 3 }), { fire: true })
  assert.equal(M.nagState(task({ dueAt: NOW - MIN, doneAt: NOW }), NOW, {}), null)
})

test("an app-wide snooze holds reminders and the review until it ends", () => {
  const t = task({ dueAt: NOW - 30 * MIN, lastNagAt: NOW - 20 * MIN })
  const p = M.plan([t], NOW, {}, { lastAt: 0 }, NOW + 15 * MIN)
  assert.equal(p.fire.length, 0)
  assert.equal(p.review, false)
  assert.equal(p.held, 2)
  assert.equal(p.wakeAt, NOW + 15 * MIN)
  const after = M.plan([t], NOW + 15 * MIN, {}, { lastAt: 0 }, NOW + 15 * MIN)
  assert.deepEqual(after.fire.map(x => x.id), [t.id])
  assert.equal(after.review, true)
})

test("snooze and quiet hours together hold until the later end", () => {
  const night = at(2026, 11, 25, 23)
  const t = task({ dueAt: night - MIN })
  const p = M.plan([t], night, { quietHours: "22:00-08:00", reviewTime: "" }, null, at(2026, 11, 26, 9))
  assert.equal(p.fire.length, 0)
  assert.equal(p.wakeAt, at(2026, 11, 26, 0), "midnight still comes first")
  const morning = M.plan([t], at(2026, 11, 26, 8, 30), { quietHours: "22:00-08:00", reviewTime: "" }, null, at(2026, 11, 26, 9))
  assert.equal(morning.fire.length, 0)
  assert.equal(morning.wakeAt, at(2026, 11, 26, 9))
})

test("NG-5: anything already overdue fires on the first plan", () => {
  const overdue = task({ dueAt: NOW - 3 * 3600000, lastNagAt: 0 })
  const later = task({ dueAt: NOW + 20 * MIN })
  const p = M.plan([overdue, later], NOW, { remindAheadMin: 0 })
  assert.deepEqual(p.fire.map(t => t.id), [overdue.id])
  assert.equal(p.wakeAt, NOW + 20 * MIN)
})

test("the plan wakes at midnight when nothing else is due", () => {
  assert.equal(M.plan([], NOW, { reviewTime: "" }).wakeAt, at(2026, 11, 26, 0))
})

test("NG-6: quiet hours hold nags until the window ends", () => {
  const night = at(2026, 11, 25, 23, 0)
  const t = task({ dueAt: night - MIN })
  const p = M.plan([t], night, { quietHours: "22:00-08:00", reviewTime: "" })
  assert.equal(p.fire.length, 0)
  assert.equal(p.held, 1)
  assert.equal(p.wakeAt, Math.min(at(2026, 11, 26, 0), at(2026, 11, 26, 8)))
  const morning = at(2026, 11, 26, 8, 0)
  assert.equal(M.plan([t], morning, { quietHours: "22:00-08:00" }).fire.length, 1)
})

test("quiet hours parse and wrap midnight", () => {
  assert.deepEqual(M.parseQuietHours("22:00-08:00"), { start: 1320, end: 480 })
  assert.deepEqual(M.parseQuietHours(" 13 - 14:30 "), { start: 780, end: 870 })
  assert.equal(M.parseQuietHours(""), null)
  assert.equal(M.parseQuietHours("25:00-08:00"), null)
  assert.equal(M.parseQuietHours("08:00-08:00"), null)
  const q = M.parseQuietHours("22:00-08:00")
  assert.equal(M.inQuietHours(at(2026, 11, 25, 23), q), true)
  assert.equal(M.inQuietHours(at(2026, 11, 25, 7, 59), q), true)
  assert.equal(M.inQuietHours(at(2026, 11, 25, 8), q), false)
  assert.equal(M.inQuietHours(at(2026, 11, 25, 12), q), false)
  assert.equal(M.quietEndAfter(at(2026, 11, 25, 23), q), at(2026, 11, 26, 8))
  assert.equal(M.quietEndAfter(at(2026, 11, 25, 3), q), at(2026, 11, 25, 8))
})

test("settings are clamped and validated", () => {
  const s = M.settingsWith({ nagEveryMin: "0", escalateAfter: "4", quietHours: "nonsense", showCount: "true" })
  assert.equal(s.nagEveryMin, 1)
  assert.equal(s.escalateAfter, undefined, "removed settings are dropped")
  assert.equal(s.quietHours, "")
  assert.equal(s.showCount, true)
  assert.equal(M.settingsWith({ nagEveryMin: "abc" }).nagEveryMin, 10)
})

// NF-8 regression: task text must never become markup or an option.
test("safeText neutralises markup, options and control characters", () => {
  assert.equal(M.safeText("<b>pay</b> & <a href='x'>go</a>"), "&lt;b&gt;pay&lt;/b&gt; &amp; &lt;a href='x'&gt;go&lt;/a&gt;")
  assert.equal(M.safeText("--exec"), "⁠--exec")
  assert.equal(M.safeText("-u critical"), "⁠-u critical")
  assert.equal(M.safeText("line1\nline2\t\u0007x"), "line1 line2 x")
  assert.equal(M.safeText(null), "")
  assert.equal(M.safeText("&amp;"), "&amp;amp;", "already-escaped text is escaped again, never trusted")
  const long = M.safeText("a".repeat(500))
  assert.equal(long.length, 200)
  assert.ok(long.endsWith("…"))
})

test("relative due descriptions", () => {
  assert.deepEqual(M.relativeDue(NOW + 20 * MIN, NOW), { key: "due.inMinutes", count: 20 })
  assert.deepEqual(M.relativeDue(NOW - 2 * 3600000, NOW), { key: "due.hoursAgo", count: 2 })
  assert.deepEqual(M.relativeDue(at(2026, 11, 28), NOW), { key: "due.inDays", count: 3 })
  assert.deepEqual(M.relativeDue(NOW, NOW), { key: "due.now", count: 0 })
  assert.equal(M.dayKind(at(2026, 11, 26), NOW), "tomorrow")
  assert.equal(M.dayKind(at(2026, 11, 29), NOW), "week")
})

test("filter matches title words and tags", () => {
  const ts = [task({ title: "Call mom", tags: ["family"] }), task({ title: "Pay rent" })]
  assert.deepEqual(M.filterTasks(ts, "mom").map(t => t.title), ["Call mom"])
  assert.deepEqual(M.filterTasks(ts, "#family").map(t => t.title), ["Call mom"])
  assert.equal(M.filterTasks(ts, "").length, 2)
  const d = [task({ title: "Call bank", description: "ask about the transfer fee" }), task({ title: "Pay rent" })]
  assert.deepEqual(M.filterTasks(d, "fee").map(t => t.title), ["Call bank"])
})

test("review: due once a day at the set time", () => {
  const s = { reviewTime: "09:00" }
  // Never done, 10:00 is past 09:00: due now (also after a late start).
  assert.deepEqual(M.reviewState(NOW, s, { lastAt: 0, laterUntil: 0 }), { fire: true })
  // Done this morning: next one tomorrow 09:00.
  assert.deepEqual(M.reviewState(NOW, s, { lastAt: at(2026, 11, 25, 9, 1), laterUntil: 0 }), { fire: false, wakeAt: at(2026, 11, 26, 9) })
  // Before 09:00, not done: wait for 09:00.
  assert.deepEqual(M.reviewState(at(2026, 11, 25, 7), s, { lastAt: at(2026, 11, 24, 9), laterUntil: 0 }), { fire: false, wakeAt: at(2026, 11, 25, 9) })
  // "Later" pushes it.
  assert.deepEqual(M.reviewState(NOW, s, { lastAt: 0, laterUntil: NOW + 3600000 }), { fire: false, wakeAt: NOW + 3600000 })
  assert.equal(M.reviewState(NOW, { reviewTime: "" }, {}), null)
})

test("review: planned with nags, held by quiet hours", () => {
  const review = { lastAt: at(2026, 11, 25, 9, 1), laterUntil: 0 }
  assert.equal(M.plan([], NOW, {}, review).wakeAt, at(2026, 11, 26, 0), "midnight comes before tomorrow's review")
  assert.equal(M.plan([], NOW, {}, { lastAt: 0 }).review, true)
  const night = at(2026, 11, 25, 23)
  const p = M.plan([], night, { quietHours: "22:00-10:00" }, { lastAt: at(2026, 11, 24, 9) })
  assert.equal(p.review, false, "today's missed review waits for quiet hours to end")
  assert.equal(p.held, 1)
  assert.equal(p.wakeAt, at(2026, 11, 26, 0))
})

test("review summary counts open tasks", () => {
  const r = M.reviewSummary([
    task({ title: "a" }), task({ title: "b" }), task({ title: "late", dueAt: NOW - MIN }), task({ title: "gone", doneAt: NOW })
  ], NOW)
  assert.equal(r.nodate, 2)
  assert.equal(r.overdue, 1)
  assert.equal(r.open, 3)
  assert.deepEqual(r.undatedTitles, ["a", "b"])
})

test("new settings validate; a mistyped review time keeps the old one", () => {
  assert.equal(M.settingsWith({ reviewTime: "8" }).reviewTime, "08:00")
  assert.equal(M.settingsWith({ reviewTime: "" }).reviewTime, "")
  assert.equal(M.settingsWith({ reviewTime: "25:99" }).reviewTime, "09:00")
  assert.equal(M.settingsWith({}).snoozeMin, 30)
  assert.equal(M.settingsWith({ snoozeMin: "0" }).snoozeMin, 1)
  assert.equal(M.settingsWith({ bareHoursPm: false }).bareHoursPm, false)
  assert.equal(M.shortDuration(15), "15 min")
  assert.equal(M.shortDuration(60), "1 h")
  assert.equal(M.shortDuration(90), "1 h 30 min")
  assert.equal(M.repeatExample(540, 10), "09:00, 09:10, 09:20")
  assert.equal(M.repeatExample(1435, 10), "23:55, 00:05, 00:15")
})

test("archived tasks are never open, due or reminded", () => {
  const a = task({ title: "shelved", dueAt: NOW - MIN, archivedAt: NOW })
  const d = task({ title: "done and archived", dueAt: NOW - MIN, doneAt: NOW - 1000, archivedAt: NOW })
  const s = M.sections([a, d], NOW)
  assert.deepEqual(s.archived.map(t => t.title).sort(), ["done and archived", "shelved"])
  assert.equal(s.overdue.length + s.done.length, 0)
  assert.equal(M.summary([a], NOW).overdue, 0)
  assert.equal(M.nagState(a, NOW, {}), null)
})

test("task groups: Today holds overdue then today; ungrouped is one list", () => {
  const ts = [
    task({ title: "later", dueAt: at(2026, 11, 27) }),
    task({ title: "late", dueAt: NOW - MIN }),
    task({ title: "tonight", dueAt: at(2026, 11, 25, 20) }),
    task({ title: "someday" }),
    task({ title: "finished", doneAt: NOW })
  ]
  const g = M.taskGroups(ts, NOW, true)
  assert.deepEqual(g.map(x => x.key), ["today", "upcoming", "nodate"])
  assert.deepEqual(g[0].tasks.map(t => t.title), ["late", "tonight"])
  const flat = M.taskGroups(ts, NOW, false)
  assert.deepEqual(flat.map(x => x.key), ["all"])
  assert.deepEqual(flat[0].tasks.map(t => t.title), ["late", "tonight", "later", "someday"])
  assert.deepEqual(M.taskGroups([task({ title: "x" })], NOW, true).map(x => x.key), ["nodate"])
  assert.deepEqual(M.taskGroups([], NOW, true), [])
})

test("lifecycle settings allow 0 for never", () => {
  const s = M.settingsWith({ keepDoneDays: 0, keepArchivedDays: "0", groupTasks: false })
  assert.equal(s.keepDoneDays, 0)
  assert.equal(s.keepArchivedDays, 0)
  assert.equal(s.groupTasks, false)
})

test("compact relative times for list rows", () => {
  assert.deepEqual(M.shortRelative(NOW + 20 * MIN, NOW), { future: true, span: "20 min" })
  assert.deepEqual(M.shortRelative(NOW - 2 * 3600000, NOW), { future: false, span: "2 h" })
  assert.deepEqual(M.shortRelative(at(2026, 11, 28, 9), NOW), { future: true, span: "3 d" })
  assert.deepEqual(M.shortRelative(at(2026, 11, 20, 9), NOW), { future: false, span: "5 d" })
  assert.equal(M.shortRelative(NOW + 10000, NOW), null)
  assert.equal(M.shortRelative(null, NOW), null)
})

test("remind ahead: an extra reminder before the due one, never instead of it", () => {
  const s = { remindAheadMin: 10 }
  const t = task({ dueAt: NOW + 30 * MIN })
  assert.deepEqual(M.nagState(t, NOW, s), { fire: false, wakeAt: NOW + 20 * MIN })
  assert.deepEqual(M.nagState(t, NOW + 20 * MIN, s), { fire: true, ahead: true })
  const p = M.plan([t], NOW + 20 * MIN, s, null)
  assert.deepEqual(p.ahead.map(x => x.id), [t.id])
  assert.equal(p.fire.length, 0)
  // Sent: it waits for the due time, and the due reminder still fires.
  t.lastNagAt = NOW + 20 * MIN
  assert.deepEqual(M.nagState(t, NOW + 21 * MIN, s), { fire: false, wakeAt: NOW + 30 * MIN })
  assert.deepEqual(M.nagState(t, NOW + 30 * MIN, s), { fire: true })
})

test("remind ahead: short notice skips the early reminder, keeps the due one", () => {
  const s = { remindAheadMin: 10 }
  // "remind in 5 minutes": the early moment is already 5 min past.
  const t = task({ dueAt: NOW + 5 * MIN })
  assert.deepEqual(M.nagState(t, NOW, s), { fire: false, wakeAt: NOW + 5 * MIN })
  const p = M.plan([t], NOW, s, null)
  assert.equal(p.ahead.length + p.fire.length, 0)
  assert.equal(p.wakeAt, NOW + 5 * MIN)
  assert.deepEqual(M.nagState(t, NOW + 5 * MIN, s), { fire: true })
  // A late wake (after sleep) skips it the same way.
  const u = task({ dueAt: NOW + 30 * MIN })
  assert.deepEqual(M.nagState(u, NOW + 25 * MIN, s), { fire: false, wakeAt: NOW + 30 * MIN })
  assert.deepEqual(M.nagState(u, NOW, { remindAheadMin: 0 }), { fire: false, wakeAt: NOW + 30 * MIN })
})

test("remind ahead: held by snooze like any reminder", () => {
  const t = task({ dueAt: NOW + 10 * MIN })
  const p = M.plan([t], NOW, { remindAheadMin: 10, reviewTime: "" }, null, NOW + 60 * MIN)
  assert.equal(p.ahead.length, 0)
  assert.equal(p.held, 1)
})

test("new settings: defaults and validation", () => {
  const d = M.settingsWith({})
  assert.equal(d.remindAheadMin, 0, "off unless turned on")
  assert.equal(d.hideTitles, false)
  assert.equal(d.weekStart, "monday")
  assert.equal(d.endOfWeek, "friday")
  const s = M.settingsWith({ remindAheadMin: "-3", hideTitles: "true", weekStart: "Sunday", endOfWeek: "nonsense" })
  assert.equal(s.remindAheadMin, 0)
  assert.equal(s.hideTitles, true)
  assert.equal(s.weekStart, "sunday")
  assert.equal(s.endOfWeek, "friday")
})

test("settingsWith reads raw values by type and keeps defaults for the rest", () => {
  const s = M.settingsWith({
    nagEveryMin: "5000", snoozeMin: "abc", hideTitles: "true", weekStart: "SUNDAY", endOfWeek: "someday",
    reviewTime: "7:5", quietHours: "22-8", unknown: 1
  })
  assert.equal(s.nagEveryMin, 1440)
  assert.equal(s.snoozeMin, 30)
  assert.equal(s.hideTitles, true)
  assert.equal(s.weekStart, "sunday")
  assert.equal(s.endOfWeek, "friday")
  assert.equal(s.reviewTime, "09:00", "a time that does not parse keeps the default")
  assert.equal(M.settingsWith({ reviewTime: "7:05" }).reviewTime, "07:05")
  assert.equal(M.settingsWith({ reviewTime: "" }).reviewTime, "", "empty turns the review off")
  assert.equal(s.quietHours, "22-8")
  assert.equal(M.settingsWith({ quietHours: "22-22" }).quietHours, "")
  assert.equal(s.unknown, undefined)
  assert.deepEqual(M.settingsWith(null), M.SETTING_DEFAULTS)
})

test("parserOptions passes the date settings to the parser", () => {
  const o = M.parserOptions({ morningHour: 7, weekStart: "sunday", nagEveryMin: 5 })
  assert.deepEqual(Object.keys(o).sort(), M.PARSER_KEYS.slice().sort())
  assert.equal(o.morningHour, 7)
  assert.equal(o.weekStart, "sunday")
  assert.equal(o.defaultHour, 9)
})
