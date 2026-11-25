.pragma library

// Natural-language task parser for Overdue. Pure JavaScript with no imports,
// so the shell loads it as a QML library and the tests load it under Node or
// Bun (tests/load.js strips the pragma line).
//
//   parse("call mom tomorrow 3pm #family !1", new Date())
//   -> { title: "call mom", dueAt: <ms>, hasTime: true, recur: null,
//        tags: ["family"], priority: 1, matched: [...] }
//
// The phrase is read word by word. At each word every matcher is tried; one
// that recognises a date, time, offset or recurrence consumes its words, and
// whatever is left over becomes the title. Each kind of slot (date, time,
// offset, recurrence) is filled once: a second "tomorrow" stays in the title.
// Words wrapped in double quotes are never parsed ("read \"Monday\" book").

var MINUTE_MS = 60000
var HOUR_MS = 3600000
var DAY_MS = 86400000

var WEEKDAYS = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6
}

// Short weekday names collide with ordinary words ("sun", "wed"), so they only
// count after on / this / next / every.
var WEEKDAY_ABBR = {
  sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6
}

var MONTHS = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
  september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11
}

var NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
  thirty: 30, fourty: 40, forty: 40, fifty: 50
}

var UNITS = {
  m: "minute", min: "minute", mins: "minute", minute: "minute", minutes: "minute",
  h: "hour", hr: "hour", hrs: "hour", hour: "hour", hours: "hour",
  d: "day", day: "day", days: "day",
  w: "week", wk: "week", wks: "week", week: "week", weeks: "week",
  mo: "month", month: "month", months: "month",
  y: "year", yr: "year", yrs: "year", year: "year", years: "year"
}

// For writing a task back as words (the edit form's boxes).
var WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
var MONTH_ABBR = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
var UNIT_WORDS = { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"], year: ["year", "years"] }

var DAY_PARTS = { morning: "morning", afternoon: "afternoon", evening: "evening", night: "night" }

var PREPOSITIONS = { on: true, at: true, by: true, due: true }

var DEFAULTS = {
  morningHour: 9,
  afternoonHour: 14,
  eveningHour: 18,
  nightHour: 21,
  // The time a task gets when it has a date but no time ("tomorrow").
  defaultHour: 9,
  // "at 1" to "at 6" mean the afternoon (13:00-18:00).
  bareHoursPm: true,
  // The first day of the week, for "next week" and "next friday":
  // "monday" or "sunday".
  weekStart: "monday",
  // What "end of week" means: "friday", or "last" (the week's last day).
  endOfWeek: "friday"
}

function options(opts) {
  var out = {}
  for (var k in DEFAULTS) out[k] = DEFAULTS[k]
  if (opts) for (var key in opts) if (opts[key] !== undefined && opts[key] !== null) out[key] = opts[key]
  return out
}

// ------------------------------------------------------------ date helpers

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count,
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate()
}

function addMonths(date, count) {
  var year = date.getFullYear()
  var monthIndex = date.getMonth() + count
  var targetYear = year + Math.floor(monthIndex / 12)
  var targetMonth = ((monthIndex % 12) + 12) % 12
  var dayOfMonth = Math.min(date.getDate(), daysInMonth(targetYear, targetMonth))
  return new Date(targetYear, targetMonth, dayOfMonth,
    date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds())
}

function atTime(date, hour, minute) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute || 0, 0, 0)
}

function nextFullHour(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours() + 1, 0, 0, 0)
}

function isWeekend(date) {
  var weekday = date.getDay()
  return weekday === 0 || weekday === 6
}

// The start of the week a day falls in, for a week starting on weekday
// `first` (1 = Monday, 0 = Sunday). "next friday" is the Friday of next week.
function weekStartOf(date, first) {
  var day = startOfDay(date)
  return addDays(day, -((day.getDay() - first + 7) % 7))
}

// --------------------------------------------------------------- tokenizing

function normalize(raw) {
  return String(raw).toLowerCase().replace(/[,;!?]+$/, "").replace(/\.$/, "")
}

function tokenize(input) {
  var raw = String(input || "").trim().split(/\s+/).filter(function(word) { return word.length > 0 })
  var tokens = []
  var quoted = false
  for (var i = 0; i < raw.length; i++) {
    var word = raw[i]
    var startsQuote = !quoted && word.charAt(0) === "\""
    if (startsQuote) quoted = true
    var protect = quoted
    var endsQuote = quoted && word.length > (startsQuote ? 1 : 0) && word.charAt(word.length - 1) === "\""
    var text = word
    if (startsQuote) text = text.slice(1)
    if (endsQuote) { text = text.slice(0, -1); quoted = false }
    tokens.push({ raw: text, lower: String(word).toLowerCase(), word: normalize(word), protect: protect, used: false })
  }
  return tokens
}

function numberOf(word) {
  if (/^\d+$/.test(word)) return parseInt(word, 10)
  if (NUMBER_WORDS[word] !== undefined) return NUMBER_WORDS[word]
  return null
}

function weekdayOf(word, allowAbbr) {
  var wordAt = String(word || "").replace(/s$/, "") // "mondays" in "every mondays"
  if (WEEKDAYS[word] !== undefined) return WEEKDAYS[word]
  if (WEEKDAYS[wordAt] !== undefined) return WEEKDAYS[wordAt]
  if (allowAbbr && WEEKDAY_ABBR[word] !== undefined) return WEEKDAY_ABBR[word]
  return fuzzyWeekday(word)
}

// ------------------------------------------------------------------ typos
//
// Quick add is typed fast, so the words that carry a date forgive a slip:
// "tommorow", "wednsday", "firday". Only long, distinctive words get this,
// with a small edit budget, so ordinary words never turn into dates.

// Edits (insert, delete, substitute, swap two neighbours) between a and b,
// giving up once it exceeds max.
function editDistance(source, target, max) {
  if (Math.abs(source.length - target.length) > max) return max + 1
  var rowBeforeLast = null
  var lastRow = []
  for (var j = 0; j <= target.length; j++) lastRow.push(j)
  for (var i = 1; i <= source.length; i++) {
    var row = [i]
    var rowMin = i
    for (var k = 1; k <= target.length; k++) {
      var cost = source.charAt(i - 1) === target.charAt(k - 1) ? 0 : 1
      var edits = Math.min(lastRow[k] + 1, row[k - 1] + 1, lastRow[k - 1] + cost)
      if (rowBeforeLast && i > 1 && k > 1 && source.charAt(i - 1) === target.charAt(k - 2) && source.charAt(i - 2) === target.charAt(k - 1))
        edits = Math.min(edits, rowBeforeLast[k - 2] + 1)
      row.push(edits)
      if (edits < rowMin) rowMin = edits
    }
    if (rowMin > max) return max + 1
    rowBeforeLast = lastRow
    lastRow = row
  }
  return lastRow[target.length]
}

function isTomorrow(word) {
  if (!word) return false
  if (word === "tomorrow" || word === "tmr" || word === "tmrw") return true
  return word.length >= 6 && word.charAt(0) === "t" && editDistance(word, "tomorrow", 2) <= 2
}

// One slip in a full weekday name. It must start with the right letter and
// keep a "-day" ending ("day", or the slips "dya" / "dy"), so "sundae" and a
// plural "thursdays" in a title stay words.
function fuzzyWeekday(word) {
  if (!word || word.length < 5) return null
  if (!/(day|dya|dy)$/.test(word)) return null
  for (var name in WEEKDAYS) {
    if (name.charAt(0) === word.charAt(0) && editDistance(word, name, 1) <= 1) return WEEKDAYS[name]
  }
  return null
}

function dayNumber(word) {
  var match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(word)
  if (!match) return null
  var day = parseInt(match[1], 10)
  return day >= 1 && day <= 31 ? day : null
}

function yearNumber(word) {
  return /^\d{4}$/.test(word) ? parseInt(word, 10) : null
}

// "3pm", "3:30pm", "15:00", "3.30pm", "9am". Returns {h, m} or null.
function clockTime(word, next) {
  var match = /^(\d{1,2})(?:[:.](\d{2}))?(am|pm|a|p)$/.exec(word)
  if (match) return twelveHour(parseInt(match[1], 10), match[2] ? parseInt(match[2], 10) : 0, match[3])
  match = /^(\d{1,2}):(\d{2})$/.exec(word)
  if (match) {
    var hour = parseInt(match[1], 10)
    var minute = parseInt(match[2], 10)
    if (next && /^(am|pm|a\.m|p\.m)$/.test(next)) {
      var time = twelveHour(hour, minute, next.charAt(0))
      if (time) time.len = 2
      return time
    }
    return hour <= 23 && minute <= 59 ? { hour: hour, minute: minute, len: 1 } : null
  }
  match = /^(\d{1,2})$/.exec(word)
  if (match && next && /^(am|pm|a\.m|p\.m)$/.test(next)) {
    var bareTime = twelveHour(parseInt(match[1], 10), 0, next.charAt(0))
    if (bareTime) bareTime.len = 2
    return bareTime
  }
  return null
}

function twelveHour(hour12, minute, suffix) {
  if (hour12 < 1 || hour12 > 12 || minute > 59) return null
  var pm = suffix.charAt(0) === "p"
  var hour24 = hour12 % 12 + (pm ? 12 : 0)
  return { hour: hour24, minute: minute, len: 1 }
}

// ----------------------------------------------------------------- matchers
//
// Each matcher looks at tokens from index i and returns
// { len, apply(state) } when it recognises a phrase, or null. `apply` returns
// false when the slot it fills is already taken, leaving the words in the
// title.

function wordAt(tokens, i) {
  var token = tokens[i]
  return token && !token.protect ? token.word : null
}

function lowerAt(tokens, i) {
  var token = tokens[i]
  return token && !token.protect ? token.lower : null
}

function setSlot(state, slot, value) {
  if (state[slot]) return false
  state[slot] = value
  return true
}

function matchRecurrence(tokens, i) {
  var first = wordAt(tokens, i)
  if (first === null) return null

  if (first === "daily") return { len: 1, slot: "recur", value: { unit: "day", every: 1 } }
  if (first === "weekly") return { len: 1, slot: "recur", value: { unit: "week", every: 1 } }
  if (first === "monthly") return { len: 1, slot: "recur", value: { unit: "month", every: 1 } }
  if (first === "yearly" || first === "annually") return { len: 1, slot: "recur", value: { unit: "year", every: 1 } }
  if (first === "weekdays" || first === "workdays") return { len: 1, slot: "recur", value: { unit: "weekday", every: 1 } }
  if (first === "on" && (wordAt(tokens, i + 1) === "weekdays" || wordAt(tokens, i + 1) === "workdays"))
    return { len: 2, slot: "recur", value: { unit: "weekday", every: 1 } }

  if (first !== "every" && first !== "each") return null
  var second = wordAt(tokens, i + 1)
  if (second === null) return null

  if (second === "weekday" || second === "weekdays" || second === "workday" || second === "workdays")
    return { len: 2, slot: "recur", value: { unit: "weekday", every: 1 } }

  var weekday = weekdayOf(second, true)
  if (weekday !== null) return { len: 2, slot: "recur", value: { unit: "week", every: 1, weekday: weekday } }

  if (DAY_PARTS[second]) return { len: 2, slot: "recur", value: { unit: "day", every: 1 }, dayPart: DAY_PARTS[second] }

  var every = 1
  var len = 2
  var unitWord = second
  if (second === "other") {
    every = 2
    unitWord = wordAt(tokens, i + 2)
    len = 3
  } else {
    var count = numberOf(second)
    if (count !== null) {
      if (count < 1) return null
      every = count
      unitWord = wordAt(tokens, i + 2)
      len = 3
    }
  }
  var unit = UNITS[unitWord]
  // Minute and hour repeats are not tasks; that is what nagging is for.
  if (!unit || unit === "minute" || unit === "hour") return null
  return { len: len, slot: "recur", value: { unit: unit, every: every } }
}

function matchOffset(tokens, i) {
  if (wordAt(tokens, i) !== "in") return null
  var second = wordAt(tokens, i + 1)
  if (second === null) return null

  // "in 20m", "in 2h", "in 3d", "in 1w"
  var compact = /^(\d+)(m|min|mins|h|hr|hrs|d|wordAt)$/.exec(second)
  if (compact) return { len: 2, slot: "offset", value: { count: parseInt(compact[1], 10), unit: UNITS[compact[2]] } }

  // "in half an hour"
  if (second === "half" && wordAt(tokens, i + 2) === "an" && wordAt(tokens, i + 3) === "hour")
    return { len: 4, slot: "offset", value: { count: 30, unit: "minute" } }

  var count = numberOf(second)
  if (count === null) return null
  var unit = UNITS[wordAt(tokens, i + 2)]
  if (!unit) return null
  return { len: 3, slot: "offset", value: { count: count, unit: unit } }
}

function matchRelativeDay(tokens, i) {
  var first = wordAt(tokens, i)
  if (first === null) return null
  if (first === "today") return { len: 1, slot: "date", value: { kind: "rel", days: 0 } }
  if (first === "tonight") return { len: 1, slot: "date", value: { kind: "rel", days: 0 }, dayPart: "night" }
  if (isTomorrow(first))
    return { len: 1, slot: "date", value: { kind: "rel", days: 1 } }
  var start = first === "the" ? 1 : 0
  if (wordAt(tokens, i + start) === "day" && wordAt(tokens, i + start + 1) === "after" && isTomorrow(wordAt(tokens, i + start + 2)))
    return { len: start + 3, slot: "date", value: { kind: "rel", days: 2 } }
  return null
}

var MONTH_FULL = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11
}
var PERIODS = { week: "week", month: "month", year: "year" }

// Periods: "next year", "next march" / "in march" (the 1st), "end of (the)
// week|month|year" and eow / eom / eoy, "the weekend" (after on / at).
// Month names alone stay words ("march madness").
function matchPeriod(tokens, i) {
  var first = wordAt(tokens, i)
  if (first === null) return null
  var second = wordAt(tokens, i + 1)

  if (first === "next" && second === "year") return { len: 2, slot: "date", value: { kind: "nextyear" } }
  if ((first === "next" || first === "in") && MONTH_FULL[second] !== undefined)
    return { len: 2, slot: "date", value: { kind: "monthStart", month: MONTH_FULL[second], next: first === "next" } }

  if (first === "eow") return { len: 1, slot: "date", value: { kind: "end", unit: "week" } }
  if (first === "eom") return { len: 1, slot: "date", value: { kind: "end", unit: "month" } }
  if (first === "eoy") return { len: 1, slot: "date", value: { kind: "end", unit: "year" } }

  var lead = first === "the" ? 1 : 0
  if (wordAt(tokens, i + lead) === "end" && wordAt(tokens, i + lead + 1) === "of") {
    var unitIndex = i + lead + 2
    if (wordAt(tokens, unitIndex) === "the") unitIndex += 1
    var unit = PERIODS[wordAt(tokens, unitIndex)]
    if (unit) return { len: unitIndex - i + 1, slot: "date", value: { kind: "end", unit: unit } }
  }

  if (first === "the" && second === "weekend") return { len: 2, slot: "date", value: { kind: "weekend", next: false } }
  return null
}

function matchWeekday(tokens, i) {
  var first = wordAt(tokens, i)
  if (first === null) return null
  var second = wordAt(tokens, i + 1)

  if ((first === "next" || first === "this" || first === "coming") && (second === "weekend"))
    return { len: 2, slot: "date", value: { kind: "weekend", next: first === "next" } }
  if (first === "next" && second === "week") return { len: 2, slot: "date", value: { kind: "nextweek" } }
  if (first === "next" && second === "month") return { len: 2, slot: "date", value: { kind: "nextmonth" } }

  if (first === "next" || first === "this" || first === "coming" || first === "on") {
    var weekday = weekdayOf(second, true)
    if (weekday !== null && WEEKDAYS[second] === undefined && WEEKDAY_ABBR[second] === undefined && fuzzyWeekday(second) === null) weekday = null
    if (weekday !== null) return { len: 2, slot: "date", value: { kind: "weekday", weekday: weekday, next: first === "next" } }
  }
  var plain = WEEKDAYS[first] !== undefined ? WEEKDAYS[first] : fuzzyWeekday(first)
  if (plain !== null) return { len: 1, slot: "date", value: { kind: "weekday", weekday: plain, next: false } }
  return null
}

function matchAbsoluteDate(tokens, i) {
  var first = wordAt(tokens, i)
  var rawFirst = lowerAt(tokens, i)
  if (first === null) return null

  // 2026-12-25
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(first)
  if (iso) return dateResult(1, parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10), true)

  // 25.12. and 25.12.2026 (the trailing dot keeps "3.5" first number)
  var dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?[,;]?$/.exec(rawFirst)
  if (dotted) {
    var dottedYear = dotted[3] ? parseInt(dotted[3], 10) : null
    if (dottedYear !== null && dottedYear < 100) dottedYear += 2000
    return dateResult(1, dottedYear, parseInt(dotted[2], 10) - 1, parseInt(dotted[1], 10), dottedYear !== null)
  }

  // 25 dec, 25th of december, 25 dec 2026
  var day = dayNumber(first)
  if (day !== null) {
    var monthAt = wordAt(tokens, i + 1) === "of" ? 2 : 1
    var month = MONTHS[wordAt(tokens, i + monthAt)]
    if (month !== undefined) {
      var year = yearNumber(wordAt(tokens, i + monthAt + 1))
      return dateResult(monthAt + 1 + (year !== null ? 1 : 0), year, month, day, year !== null)
    }
  }

  // dec 25, december 25th, dec 25 2026
  var monthFirst = MONTHS[first]
  if (monthFirst !== undefined) {
    var monthDay = dayNumber(wordAt(tokens, i + 1))
    if (monthDay !== null) {
      var monthDayYear = yearNumber(wordAt(tokens, i + 2))
      return dateResult(2 + (monthDayYear !== null ? 1 : 0), monthDayYear, monthFirst, monthDay, monthDayYear !== null)
    }
  }
  return null
}

function dateResult(len, year, month, day, yearGiven) {
  if (month < 0 || month > 11 || day < 1) return null
  var checkYear = year !== null ? year : 2000 // leap year, so 29 feb passes
  if (day > daysInMonth(checkYear, month)) return null
  return { len: len, slot: "date", value: { kind: "abs", year: year, month: month, day: day, yearGiven: yearGiven } }
}

function matchTime(tokens, i, state, prevUsed) {
  var first = wordAt(tokens, i)
  if (first === null) return null
  var second = wordAt(tokens, i + 1)
  var third = wordAt(tokens, i + 2)

  if (first === "noon" || first === "midday" || first === "lunchtime") return { len: 1, slot: "time", value: { hour: 12, minute: 0 } }
  // "lunch" alone is first word ("pack lunch box"); after at or first date it is noon.
  if (first === "lunch" && prevUsed) return { len: 1, slot: "time", value: { hour: 12, minute: 0 } }
  if (first === "midnight") return { len: 1, slot: "time", value: { hour: 23, minute: 59 } }

  if (first === "at") {
    if (second === "noon" || second === "midday" || second === "lunch" || second === "lunchtime") return { len: 2, slot: "time", value: { hour: 12, minute: 0 } }
    if (second === "midnight") return { len: 2, slot: "time", value: { hour: 23, minute: 59 } }
    var time = clockTime(second, third)
    if (time) return { len: 1 + time.len, slot: "time", value: { hour: time.hour, minute: time.minute } }
    // "at 9" / "at 5": first bare hour. 1-6 reads as the afternoon, the way
    // people say "at 5" for 17:00.
    var bare = /^(\d{1,2})$/.exec(second || "")
    if (bare) {
      var hour = parseInt(bare[1], 10)
      if (hour > 23) return null
      if (state.opts.bareHoursPm !== false && hour >= 1 && hour <= 6) hour += 12
      return { len: 2, slot: "time", value: { hour: hour, minute: 0 } }
    }
    return null
  }

  var clock = clockTime(first, second)
  if (clock) return { len: clock.len, slot: "time", value: { hour: clock.hour, minute: clock.minute } }

  // Day parts read as first time only next to first date or after "this" / "in the",
  // so "morning run" stays first title.
  if ((first === "this") && DAY_PARTS[second]) return { len: 2, slot: "dayPart", value: DAY_PARTS[second] }
  if (first === "in" && second === "the" && DAY_PARTS[third]) return { len: 3, slot: "dayPart", value: DAY_PARTS[third] }
  if (DAY_PARTS[first] && prevUsed) return { len: 1, slot: "dayPart", value: DAY_PARTS[first] }
  return null
}

function matchMeta(tokens, i) {
  var token = tokens[i]
  if (!token || token.protect) return null
  var raw = token.raw
  var tag = /^#([^\s#]+?)[,;.!?]*$/.exec(raw)
  if (tag && tag[1].length > 0) return { len: 1, slot: "tags", value: tag[1].toLowerCase() }
  var prio = /^!([1-3])$/.exec(raw)
  if (prio) return { len: 1, slot: "priority", value: parseInt(prio[1], 10) }
  return null
}

var MATCHERS = [matchMeta, matchRecurrence, matchOffset, matchRelativeDay, matchPeriod, matchWeekday, matchAbsoluteDate, matchTime]

function applyMatch(state, match) {
  if (match.slot === "tags") {
    if (state.tags.indexOf(match.value) === -1) state.tags.push(match.value)
    return true
  }
  if (!setSlot(state, match.slot, match.value)) return false
  if (match.dayPart && !state.dayPart) state.dayPart = match.dayPart
  return true
}

// ------------------------------------------------------------------ parsing

// Everything after the first " -- " is the task's description, kept as
// written and never read for dates: "call bank tomorrow -- ask about the fee".
function splitDescription(input) {
  var text = String(input || "")
  var separator = /(^|\s)--(\s|$)/.exec(text)
  if (!separator) return { line: text, description: "" }
  return { line: text.slice(0, separator.index), description: text.slice(separator.index + separator[0].length).trim() }
}

function parse(input, now, opts) {
  var config = options(opts)
  var nowDate = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)
  var split = splitDescription(input)
  input = split.line
  var tokens = tokenize(input)
  var state = { tags: [], opts: config }
  var matched = []

  var i = 0
  while (i < tokens.length) {
    var prevUsed = i > 0 && tokens[i - 1].used
    var hit = tryMatch(tokens, i, state, prevUsed)
    var start = i
    // A preposition in front of a phrase goes with it: "on friday", "by 25 dec".
    if (!hit && PREPOSITIONS[wordAt(tokens, i)] && tokens[i + 1]) {
      hit = tryMatch(tokens, i + 1, state, true)
      if (hit) hit.len += 1
    }
    if (hit) {
      var words = []
      for (var j = start; j < start + hit.len; j++) {
        tokens[j].used = true
        words.push(tokens[j].raw)
      }
      matched.push(words.join(" "))
      i = start + hit.len
    } else {
      i += 1
    }
  }

  var title = tokens.filter(function(token) { return !token.used }).map(function(token) { return token.raw }).join(" ").trim()
  // What no phrase claimed. Empty means the line was all date, tags and so on
  // (the edit form's Due box needs exactly that).
  var rest = title
  // A preposition left dangling at the end belonged to a phrase that did not
  // parse; keep it, it is the user's text. Only fall back to the whole input
  // when nothing is left.
  if (title === "") title = String(input || "").trim()

  var resolved = resolve(state, nowDate, config)
  return {
    title: title,
    dueAt: resolved.dueAt,
    hasTime: resolved.hasTime,
    recur: state.recur || null,
    tags: state.tags,
    priority: state.priority || 0,
    description: split.description,
    rest: rest,
    matched: matched
  }
}

function tryMatch(tokens, i, state, prevUsed) {
  for (var matcher = 0; matcher < MATCHERS.length; matcher++) {
    var match = MATCHERS[matcher](tokens, i, state, prevUsed)
    if (!match) continue
    // Never consume words that a quote protected or that an earlier phrase
    // already took.
    var ok = true
    for (var k = i; k < i + match.len; k++) if (!tokens[k] || tokens[k].protect || tokens[k].used) ok = false
    if (!ok) continue
    if (applyMatch(state, match)) return { len: match.len }
  }
  return null
}

function dayPartHour(part, config) {
  if (part === "morning") return config.morningHour
  if (part === "afternoon") return config.afternoonHour
  if (part === "evening") return config.eveningHour
  if (part === "night") return config.nightHour
  return config.defaultHour
}

function resolveDate(date, now, config) {
  var today = startOfDay(now)
  var first = config && config.weekStart === "sunday" ? 0 : 1
  if (date.kind === "rel") return addDays(today, date.days)
  if (date.kind === "weekday") {
    var diff = (date.weekday - today.getDay() + 7) % 7
    if (diff === 0) diff = 7
    if (date.next) {
      // The given day in next calendar week (weekStart says when weeks begin).
      var nextWeek = addDays(weekStartOf(today, first), 7)
      return addDays(nextWeek, (date.weekday - first + 7) % 7)
    }
    return addDays(today, diff)
  }
  if (date.kind === "weekend") {
    var toSaturday = (6 - today.getDay() + 7) % 7
    if (today.getDay() === 0) toSaturday = date.next ? 6 : 0 // Sunday is still this weekend
    else if (date.next) toSaturday += 7
    return addDays(today, toSaturday)
  }
  if (date.kind === "nextweek") return addDays(weekStartOf(today, first), 7)
  if (date.kind === "nextyear") return new Date(today.getFullYear() + 1, 0, 1)
  if (date.kind === "monthStart") {
    var thisMonth = today.getMonth()
    var thisYear = today.getFullYear()
    if (date.next) return new Date(date.month > thisMonth ? thisYear : thisYear + 1, date.month, 1)
    if (date.month === thisMonth) return today
    return new Date(date.month > thisMonth ? thisYear : thisYear + 1, date.month, 1)
  }
  if (date.kind === "end") {
    if (date.unit === "week") {
      // Friday, or the week's last day (Sunday, or Saturday when weeks start on Sunday).
      var endDay = config && config.endOfWeek === "last" ? (first + 6) % 7 : 5
      return addDays(today, (endDay - today.getDay() + 7) % 7)
    }
    if (date.unit === "month") return new Date(today.getFullYear(), today.getMonth() + 1, 0)
    return new Date(today.getFullYear(), 11, 31)
  }
  if (date.kind === "nextmonth") return new Date(today.getFullYear(), today.getMonth() + 1, 1)
  if (date.kind === "abs") {
    var year = date.year !== null ? date.year : today.getFullYear()
    var resolved = new Date(year, date.month, Math.min(date.day, daysInMonth(year, date.month)))
    if (!date.yearGiven && resolved < today) resolved = new Date(year + 1, date.month, Math.min(date.day, daysInMonth(year + 1, date.month)))
    return resolved
  }
  return today
}

function resolve(state, now, config) {
  var explicitTime = !!(state.time || state.dayPart)
  var hour = state.time ? state.time.hour : (state.dayPart ? dayPartHour(state.dayPart, config) : config.defaultHour)
  var minute = state.time ? state.time.minute : 0

  if (state.offset) {
    var offset = state.offset
    if (offset.unit === "minute") return { dueAt: now.getTime() + offset.count * MINUTE_MS, hasTime: true }
    if (offset.unit === "hour") return { dueAt: now.getTime() + offset.count * HOUR_MS, hasTime: true }
    var base = startOfDay(now)
    if (offset.unit === "day") base = addDays(base, offset.count)
    else if (offset.unit === "week") base = addDays(base, offset.count * 7)
    else if (offset.unit === "month") base = addMonths(base, offset.count)
    else if (offset.unit === "year") base = addMonths(base, offset.count * 12)
    return { dueAt: atTime(base, hour, minute).getTime(), hasTime: explicitTime }
  }

  if (state.recur && !state.date) {
    return { dueAt: firstOccurrence(state.recur, now, hour, minute).getTime(), hasTime: explicitTime }
  }

  if (state.date) {
    var day = resolveDate(state.date, now, config)
    var dueDate = atTime(day, hour, minute)
    // "today" without a time, after the default hour has passed: the next
    // full hour, rather than a task that is overdue the moment it is saved.
    if (!explicitTime && dueDate.getTime() <= now.getTime() && startOfDay(dueDate).getTime() === startOfDay(now).getTime())
      dueDate = nextFullHour(now)
    return { dueAt: dueDate.getTime(), hasTime: explicitTime }
  }

  if (explicitTime) {
    var dueDate = atTime(now, hour, minute)
    if (dueDate.getTime() <= now.getTime()) dueDate = addDays(dueDate, 1)
    return { dueAt: dueDate.getTime(), hasTime: true }
  }

  return { dueAt: null, hasTime: false }
}

// The first moment a recurrence fires at or after now.
function firstOccurrence(recur, now, hour, minute) {
  var candidate = atTime(now, hour, minute)
  if (recur.unit === "week" && recur.weekday !== undefined) {
    var diff = (recur.weekday - candidate.getDay() + 7) % 7
    candidate = addDays(candidate, diff)
    if (candidate.getTime() <= now.getTime()) candidate = addDays(candidate, 7)
    return candidate
  }
  if (recur.unit === "weekday") {
    while (isWeekend(candidate) || candidate.getTime() <= now.getTime()) candidate = addDays(candidate, 1)
    return candidate
  }
  if (candidate.getTime() <= now.getTime()) candidate = addDays(candidate, 1)
  return candidate
}

// The next due moment after completing a recurring task that was due at
// prevDueAt: steps by the interval, keeping the local time of day, until it
// lands after now.
function nextOccurrence(recur, prevDueAt, now) {
  if (!recur) return null
  var nowMs = now instanceof Date ? now.getTime() : Number(now)
  var next = new Date(prevDueAt)
  var every = Math.max(1, recur.every || 1)
  var steps = 0
  do {
    if (recur.unit === "day") next = addDays(next, every)
    else if (recur.unit === "week") next = addDays(next, 7 * every)
    else if (recur.unit === "weekday") {
      next = addDays(next, 1)
      while (isWeekend(next)) next = addDays(next, 1)
    } else if (recur.unit === "month") next = addMonths(next, every)
    else if (recur.unit === "year") next = addMonths(next, 12 * every)
    else return null
    steps += 1
  } while (next.getTime() <= nowMs && steps < 100000)
  return next.getTime()
}

// A recurrence rule as a compact, stable string for storage and display
// lookups: "day:1", "week:2", "week:1:5" (Fridays), "weekday", "month:1".
function recurToString(recur) {
  if (!recur) return ""
  if (recur.unit === "weekday") return "weekday"
  var text = recur.unit + ":" + (recur.every || 1)
  if (recur.weekday !== undefined) text += ":" + recur.weekday
  return text
}

function recurFromString(text) {
  if (!text) return null
  var parts = String(text).split(":")
  if (parts[0] === "weekday") return { unit: "weekday", every: 1 }
  if (["day", "week", "month", "year"].indexOf(parts[0]) === -1) return null
  var recur = { unit: parts[0], every: Math.max(1, parseInt(parts[1], 10) || 1) }
  if (parts.length > 2 && parts[2] !== "") {
    var weekday = parseInt(parts[2], 10)
    if (weekday >= 0 && weekday <= 6) recur.weekday = weekday
  }
  return recur
}

function pad2(value) {
  return (value < 10 ? "0" : "") + value
}

// The edit form's Task box: the title (quoted when it would itself read as
// a date or a tag) with its tags and priority. No date.
function titlePhrase(task) {
  var title = String(task.title || "")
  var probe = parse(title, new Date(2000, 0, 1))
  var parts = [probe.matched.length > 0 && title.indexOf("\"") === -1 ? "\"" + title + "\"" : title]
  var tags = task.tags || []
  for (var i = 0; i < tags.length; i++) parts.push("#" + tags[i])
  if (task.priority > 0) parts.push("!" + task.priority)
  return parts.join(" ")
}

function recurPhrase(recur) {
  if (!recur) return ""
  if (recur.unit === "weekday") return "every weekday"
  if (recur.unit === "week" && recur.weekday !== undefined) return "every " + WEEKDAY_NAMES[recur.weekday]
  if (recur.every > 1) return "every " + recur.every + " " + UNIT_WORDS[recur.unit][1]
  return "every " + UNIT_WORDS[recur.unit][0]
}

// The edit form's Due box: the date in words that read back to the same
// moment, "today 15:00", "tomorrow 09:00", "friday 09:00", "27 dec 09:00",
// "3 jan 2027 09:00",
// with the repeat after it ("every month"). Empty without a due date.
function duePhrase(task, now) {
  if (task.dueAt === null || task.dueAt === undefined) return ""
  var reference = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now)
  var due = new Date(task.dueAt)
  var days = Math.round((startOfDay(due) - startOfDay(reference)) / DAY_MS)
  var day
  if (days === 0) day = "today"
  else if (days === 1) day = "tomorrow"
  // Within the coming week the weekday reads better, and "friday" means the
  // next Friday, which is this one.
  else if (days > 1 && days < 7) day = WEEKDAY_NAMES[due.getDay()]
  else day = due.getDate() + " " + MONTH_ABBR[due.getMonth()] + (due.getFullYear() !== reference.getFullYear() || days < 0 ? " " + due.getFullYear() : "")
  var parts = [day, pad2(due.getHours()) + ":" + pad2(due.getMinutes())]
  var recur = typeof task.recur === "string" ? recurFromString(task.recur) : task.recur
  if (recur) parts.push(recurPhrase(recur))
  return parts.join(" ")
}

// A whole task as one line (quick add syntax), for IPC and tests.
function phrase(task) {
  var parts = [titlePhrase(task)]
  var recur = typeof task.recur === "string" ? recurFromString(task.recur) : task.recur
  if (recur) parts.push(recurPhrase(recur))
  if (task.dueAt !== null && task.dueAt !== undefined) {
    var due = new Date(task.dueAt)
    parts.push(due.getFullYear() + "-" + pad2(due.getMonth() + 1) + "-" + pad2(due.getDate()) + " " + pad2(due.getHours()) + ":" + pad2(due.getMinutes()))
  }
  if (task.description) parts.push("-- " + task.description)
  return parts.join(" ")
}

// Node/Bun test hook; QML never sees `module`.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parse: parse, nextOccurrence: nextOccurrence, firstOccurrence: firstOccurrence,
    recurToString: recurToString, recurFromString: recurFromString,
    phrase: phrase, titlePhrase: titlePhrase, duePhrase: duePhrase,
    DEFAULTS: DEFAULTS
  }
}
