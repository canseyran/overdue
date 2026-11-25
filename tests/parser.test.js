"use strict"
// Run with: node --test tests/   (or: bun test tests/)
const test = require("node:test")
const assert = require("node:assert/strict")
const P = require("./load")("Parser.js")

// Wednesday 25 November 2026, 10:00 local time.
const NOW = new Date(2026, 10, 25, 10, 0)
const at = (y, m, d, h = 9, mi = 0) => new Date(y, m - 1, d, h, mi).getTime()
const parse = (s, now = NOW) => P.parse(s, now)

test("reference day is a Wednesday", () => {
  assert.equal(NOW.getDay(), 3)
})

test("NL-8: the date phrase leaves the title", () => {
  const r = parse("call mom tomorrow 3pm")
  assert.equal(r.title, "call mom")
  assert.equal(r.dueAt, at(2026, 11, 26, 15))
  assert.equal(r.hasTime, true)
})

test("no date leaves the task undated", () => {
  const r = parse("buy 3 apples")
  assert.equal(r.title, "buy 3 apples")
  assert.equal(r.dueAt, null)
})

test("NL-1: relative days", () => {
  assert.equal(parse("x today", new Date(2026, 10, 25, 8, 0)).dueAt, at(2026, 11, 25, 9))
  assert.equal(parse("x tonight").dueAt, at(2026, 11, 25, 21))
  assert.equal(parse("x tomorrow").dueAt, at(2026, 11, 26, 9))
  assert.equal(parse("x tomorrow").hasTime, false)
  assert.equal(parse("x day after tomorrow").dueAt, at(2026, 11, 27, 9))
  assert.equal(parse("x the day after tomorrow").title, "x")
  assert.equal(parse("x tmrw").dueAt, at(2026, 11, 26, 9))
})

test("NL-2: weekdays", () => {
  assert.equal(parse("x monday").dueAt, at(2026, 11, 30))
  assert.equal(parse("x wednesday").dueAt, at(2026, 12, 2), "same weekday means next week")
  assert.equal(parse("x friday").dueAt, at(2026, 11, 27))
  assert.equal(parse("x on fri").dueAt, at(2026, 11, 27))
  assert.equal(parse("x next friday").dueAt, at(2026, 12, 4))
  assert.equal(parse("x this weekend").dueAt, at(2026, 11, 28))
  assert.equal(parse("x next weekend").dueAt, at(2026, 12, 5))
})

test("abbreviated weekdays need a lead word", () => {
  const r = parse("wash the sun hat")
  assert.equal(r.dueAt, null)
  assert.equal(r.title, "wash the sun hat")
})

test("NL-3: offsets", () => {
  assert.equal(parse("x in 20m").dueAt, NOW.getTime() + 20 * 60000)
  assert.equal(parse("x in 2 hours").dueAt, NOW.getTime() + 2 * 3600000)
  assert.equal(parse("x in an hour").dueAt, NOW.getTime() + 3600000)
  assert.equal(parse("x in half an hour").dueAt, NOW.getTime() + 30 * 60000)
  assert.equal(parse("x in 3 days").dueAt, at(2026, 11, 28))
  assert.equal(parse("x in 3 days at 5pm").dueAt, at(2026, 11, 28, 17))
  assert.equal(parse("x next week").dueAt, at(2026, 11, 30))
  assert.equal(parse("x next month").dueAt, at(2026, 12, 1))
})

test("NL-4: times", () => {
  assert.equal(parse("x 3pm").dueAt, at(2026, 11, 25, 15))
  assert.equal(parse("x 15:00").dueAt, at(2026, 11, 25, 15))
  assert.equal(parse("x 3:30 pm").dueAt, at(2026, 11, 25, 15, 30))
  assert.equal(parse("x at 9").dueAt, at(2026, 11, 26, 9), "a past time today rolls to tomorrow")
  assert.equal(parse("x at 5").dueAt, at(2026, 11, 25, 17), "a bare small hour means the afternoon")
  assert.equal(parse("x noon").dueAt, at(2026, 11, 25, 12))
  assert.equal(parse("x tomorrow morning").dueAt, at(2026, 11, 26, 9))
  assert.equal(parse("x tomorrow evening").dueAt, at(2026, 11, 26, 18))
  assert.equal(parse("x this afternoon").dueAt, at(2026, 11, 25, 14))
  assert.equal(parse("x 9am").dueAt, at(2026, 11, 26, 9))
})

test("NL-4: day-part hours are configurable", () => {
  const r = P.parse("x tomorrow evening", NOW, { eveningHour: 19 })
  assert.equal(r.dueAt, at(2026, 11, 26, 19))
  const d = P.parse("x tomorrow", NOW, { defaultHour: 8 })
  assert.equal(d.dueAt, at(2026, 11, 26, 8))
})

test("day parts alone stay in the title", () => {
  const r = parse("morning run")
  assert.equal(r.title, "morning run")
  assert.equal(r.dueAt, null)
})

test("NL-5: absolute dates", () => {
  assert.equal(parse("x 25 dec").dueAt, at(2026, 12, 25))
  assert.equal(parse("x dec 25").dueAt, at(2026, 12, 25))
  assert.equal(parse("x december 25th").dueAt, at(2026, 12, 25))
  assert.equal(parse("x 25th of december").dueAt, at(2026, 12, 25))
  assert.equal(parse("x 2026-12-25").dueAt, at(2026, 12, 25))
  assert.equal(parse("x 25.12.").dueAt, at(2026, 12, 25))
  assert.equal(parse("x 25.12.2027").dueAt, at(2027, 12, 25))
  assert.equal(parse("x 1 jan").dueAt, at(2027, 1, 1), "a past date without a year means next year")
  assert.equal(parse("x 3 jan 2026").dueAt, at(2026, 1, 3), "an explicit past year stays")
  assert.equal(parse("x dec 24 4pm").dueAt, at(2026, 12, 24, 16))
})

test("invalid dates are not dates", () => {
  assert.equal(parse("x 31 feb").dueAt, null)
  assert.equal(parse("version 3.5 release").dueAt, null)
})

test("prepositions go with their phrase", () => {
  assert.equal(parse("pay rent by friday").title, "pay rent")
  assert.equal(parse("meet at 5pm").title, "meet")
  assert.equal(parse("dentist on 2 dec at 10:30").title, "dentist")
  assert.equal(parse("dentist on 2 dec at 10:30").dueAt, at(2026, 12, 2, 10, 30))
})

test("NL-6: recurrence", () => {
  let r = parse("standup every weekday 9:30")
  assert.deepEqual(r.recur, { unit: "weekday", every: 1 })
  assert.equal(r.dueAt, at(2026, 11, 26, 9, 30))
  assert.equal(r.title, "standup")

  r = parse("gym every monday 9am")
  assert.deepEqual(r.recur, { unit: "week", every: 1, weekday: 1 })
  assert.equal(r.dueAt, at(2026, 11, 30, 9))

  r = parse("water plants every 2 weeks")
  assert.deepEqual(r.recur, { unit: "week", every: 2 })

  r = parse("vitamins every day 8pm")
  assert.deepEqual(r.recur, { unit: "day", every: 1 })
  assert.equal(r.dueAt, at(2026, 11, 25, 20))

  r = parse("journal every evening")
  assert.deepEqual(r.recur, { unit: "day", every: 1 })
  assert.equal(r.dueAt, at(2026, 11, 25, 18))

  assert.deepEqual(parse("invoice monthly").recur, { unit: "month", every: 1 })
  assert.deepEqual(parse("review weekdays").recur, { unit: "weekday", every: 1 })
  assert.deepEqual(parse("x every other week").recur, { unit: "week", every: 2 })
})

test("nextOccurrence keeps the time of day and skips past moments", () => {
  const r = { unit: "day", every: 1 }
  assert.equal(P.nextOccurrence(r, at(2026, 11, 20, 8), NOW), at(2026, 11, 26, 8))
  const wd = { unit: "weekday", every: 1 }
  assert.equal(P.nextOccurrence(wd, at(2026, 11, 27, 9), at(2026, 11, 27, 9, 30)), at(2026, 11, 30, 9))
  const m = { unit: "month", every: 1 }
  assert.equal(P.nextOccurrence(m, at(2026, 1, 31, 9), at(2026, 1, 31, 10)), at(2026, 2, 28, 9))
})

test("recurrence round-trips through its storage string", () => {
  for (const r of [{ unit: "weekday", every: 1 }, { unit: "week", every: 2 }, { unit: "week", every: 1, weekday: 5 }, { unit: "month", every: 3 }]) {
    assert.deepEqual(P.recurFromString(P.recurToString(r)), r)
  }
  assert.equal(P.recurFromString("bogus"), null)
  assert.equal(P.recurFromString(""), null)
})

test("NL-7: tags and priority", () => {
  const r = parse("ship release #work #Urgent !1 tomorrow")
  assert.equal(r.title, "ship release")
  assert.deepEqual(r.tags, ["work", "urgent"])
  assert.equal(r.priority, 1)
  // The removed per-task reminder option is plain title text now.
  assert.equal(parse("x nag:5").title, "x nag:5")
  assert.equal(parse("wow! great").priority, 0)
})

test("quoted words are never parsed", () => {
  const r = parse("read \"next monday\" essay tomorrow")
  assert.equal(r.title, "read next monday essay")
  assert.equal(r.dueAt, at(2026, 11, 26, 9))
})

test("each slot fills once", () => {
  const r = parse("tomorrow call tomorrow")
  assert.equal(r.title, "call tomorrow")
})

test("only a phrase falls back to the input as title", () => {
  assert.equal(parse("tomorrow").title, "tomorrow")
})

test("phrase() writes a task back as a line that parses to the same task", () => {
  const tasks = [
    { title: "call mom", dueAt: at(2026, 11, 26, 15), tags: ["family"], priority: 1, recur: "" },
    { title: "read next monday essay", dueAt: null, tags: [], priority: 0, recur: "" },
    { title: "gym", dueAt: at(2026, 11, 30, 9), tags: [], priority: 0, recur: "week:1:1" },
    { title: "water", dueAt: at(2026, 12, 2, 8), tags: [], priority: 0, recur: "week:2" },
    { title: "standup", dueAt: at(2026, 11, 26, 9, 30), tags: [], priority: 0, recur: "weekday" }
  ]
  for (const t of tasks) {
    const line = P.phrase(t)
    const r = parse(line)
    assert.equal(r.title, t.title, line)
    assert.equal(r.dueAt, t.dueAt, line)
    assert.deepEqual(r.tags, t.tags, line)
    assert.equal(r.priority, t.priority, line)
    assert.equal(P.recurToString(r.recur), t.recur, line)
  }
})

test("typos in tomorrow and weekday names still parse", () => {
  for (const w of ["tommorow", "tommorrow", "tomorow", "tomorrw", "tomrrow", "tmrw"]) {
    const r = parse(`do something ${w}`)
    assert.equal(r.dueAt, at(2026, 11, 26, 9), w)
    assert.equal(r.title, "do something", w)
  }
  assert.equal(parse("x day after tommorow").dueAt, at(2026, 11, 27))
  assert.equal(parse("x wednsday").dueAt, at(2026, 12, 2))
  assert.equal(parse("x firday 3pm").dueAt, at(2026, 11, 27, 15))
  assert.equal(parse("x next thrusday").dueAt, at(2026, 12, 3))
  assert.equal(parse("x every mondya").recur.weekday, 1)
})

test("typo tolerance leaves ordinary words alone", () => {
  for (const s of ["buy tomatoes", "fix the tumour report", "borrow money", "eat a sundae", "call frida", "thursdays club notes", "tonight show recap"]) {
    const r = parse(s)
    if (s.startsWith("tonight")) continue
    assert.equal(r.dueAt, null, s)
    assert.equal(r.title, s, s)
  }
})

test("today without a time, after the default hour, is the next full hour", () => {
  assert.equal(parse("do something today").dueAt, at(2026, 11, 25, 11))
  assert.equal(parse("x today", new Date(2026, 10, 25, 15, 20)).dueAt, at(2026, 11, 25, 16))
  assert.equal(parse("x today 9am").dueAt, at(2026, 11, 25, 9), "an explicit past time stays as written")
  assert.equal(parse("x 25 nov").dueAt, at(2026, 11, 25, 11))
})

test("bare small hours can be read as morning", () => {
  assert.equal(P.parse("x at 5", NOW, { bareHoursPm: false }).dueAt, at(2026, 11, 26, 5))
})

test("a description follows -- and is never parsed", () => {
  const r = parse("call bank tomorrow 3pm -- ask about the fee before monday")
  assert.equal(r.title, "call bank")
  assert.equal(r.dueAt, at(2026, 11, 26, 15))
  assert.equal(r.description, "ask about the fee before monday")
  assert.equal(parse("call bank").description, "")
  assert.equal(parse("call bank --").description, "")
  assert.equal(parse("pre--release notes").title, "pre--release notes", "-- inside a word is text")
  assert.equal(parse("a -- b -- c").description, "b -- c", "only the first -- splits")
  const t = { title: "call bank", dueAt: at(2026, 11, 26, 15), tags: ["work"], priority: 0, recur: "", description: "ask about the fee" }
  const back = parse(P.phrase(t))
  assert.equal(back.title, "call bank")
  assert.equal(back.description, "ask about the fee")
  assert.deepEqual(back.tags, ["work"])
})

test("edit form: Task and Due boxes read back to the same task", () => {
  const tasks = [
    { title: "call bank", dueAt: at(2026, 11, 26, 15), tags: ["work"], priority: 1, recur: "" },
    { title: "read next monday essay", dueAt: at(2026, 11, 25, 18, 30), tags: [], priority: 0, recur: "" },
    { title: "rent", dueAt: at(2026, 12, 1, 9), tags: [], priority: 0, recur: "month:1" },
    { title: "gym", dueAt: at(2026, 11, 30, 7), tags: [], priority: 0, recur: "week:1:1" },
    { title: "renew passport", dueAt: at(2027, 1, 3, 9), tags: [], priority: 0, recur: "" },
    { title: "late one", dueAt: at(2026, 11, 20, 9), tags: [], priority: 0, recur: "" }
  ]
  for (const t of tasks) {
    const titleBox = P.titlePhrase(t)
    const dueBox = P.duePhrase(t, NOW)
    const a = parse(titleBox)
    const b = parse(dueBox)
    assert.equal(a.title, t.title, titleBox)
    assert.equal(a.dueAt, null, "no date in the Task box: " + titleBox)
    assert.deepEqual(a.tags, t.tags, titleBox)
    assert.equal(a.priority, t.priority, titleBox)
    assert.equal(b.dueAt, t.dueAt, dueBox)
    assert.equal(b.rest, "", "the Due box is all date: " + dueBox)
    assert.equal(P.recurToString(b.recur), t.recur, dueBox)
  }
  assert.equal(P.duePhrase(tasks[0], NOW), "tomorrow 15:00")
  assert.equal(P.duePhrase(tasks[1], NOW), "today 18:30")
  assert.equal(P.duePhrase(tasks[2], NOW), "tuesday 09:00 every month")
  assert.equal(P.duePhrase({ dueAt: at(2026, 12, 25, 9) }, NOW), "25 dec 09:00")
  assert.equal(P.duePhrase(tasks[4], NOW), "3 jan 2027 09:00")
  assert.equal(P.duePhrase({ dueAt: null }, NOW), "")
  assert.equal(parse("blah 9am").rest, "blah", "leftover words show the Due box was not all date")
})

test("more phrases: next year, months, end of week/month/year, the weekend, lunch", () => {
  const r = parse("next year check logs")
  assert.equal(r.title, "check logs")
  assert.equal(r.dueAt, at(2027, 1, 1))
  assert.equal(parse("check logs next year 3pm").dueAt, at(2027, 1, 1, 15))
  assert.equal(parse("x next march").dueAt, at(2027, 3, 1))
  assert.equal(parse("x in december").dueAt, at(2026, 12, 1))
  assert.equal(parse("x in march").dueAt, at(2027, 3, 1))
  assert.equal(parse("x next december").dueAt, at(2026, 12, 1))
  assert.equal(parse("x next november").dueAt, at(2027, 11, 1), "the current month means next year's")
  assert.equal(parse("x end of week").dueAt, at(2026, 11, 27))
  assert.equal(parse("x by the end of the week").dueAt, at(2026, 11, 27))
  assert.equal(parse("x eow").dueAt, at(2026, 11, 27))
  assert.equal(parse("x end of month").dueAt, at(2026, 11, 30))
  assert.equal(parse("x eom 5pm").dueAt, at(2026, 11, 30, 17))
  assert.equal(parse("x end of year").dueAt, at(2026, 12, 31))
  assert.equal(parse("x eoy").title, "x")
  assert.equal(parse("x on the weekend").dueAt, at(2026, 11, 28))
  assert.equal(parse("x at the weekend").dueAt, at(2026, 11, 28))
  assert.equal(parse("x tomorrow at lunch").dueAt, at(2026, 11, 26, 12))
  assert.equal(parse("x lunchtime").dueAt, at(2026, 11, 25, 12))
  // Ordinary words stay words.
  assert.equal(parse("buy march madness tickets").dueAt, null)
  assert.equal(parse("pack lunch box").dueAt, null)
  assert.equal(parse("end of an era essay").dueAt, null)
})

test("week settings: first day of the week and end of week", () => {
  // NOW is Wednesday 25 Nov 2026.
  const sun = { weekStart: "sunday" }
  assert.equal(P.parse("x next week", NOW).dueAt, at(2026, 11, 30), "Monday start")
  assert.equal(P.parse("x next week", NOW, sun).dueAt, at(2026, 11, 29), "Sunday start")
  assert.equal(P.parse("x next friday", NOW, sun).dueAt, at(2026, 12, 4))
  assert.equal(P.parse("x next sunday", NOW).dueAt, at(2026, 12, 6), "Sunday ends a Monday week")
  assert.equal(P.parse("x next sunday", NOW, sun).dueAt, at(2026, 11, 29), "Sunday starts a Sunday week")
  assert.equal(P.parse("x end of week", NOW).dueAt, at(2026, 11, 27), "Friday by default")
  assert.equal(P.parse("x end of week", NOW, { endOfWeek: "last" }).dueAt, at(2026, 11, 29), "Sunday")
  assert.equal(P.parse("x eow", NOW, { endOfWeek: "last", weekStart: "sunday" }).dueAt, at(2026, 11, 28), "Saturday")
})
