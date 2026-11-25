import QtQuick
import QtQuick.Layouts
import QtQuick.Controls as QQC
import Quickshell
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model
import "Parser.js" as Parser

// The task panel that grows out of the bar icon, built like Omarchy's own
// panels (the Agents panel in particular): a hero with tinted square buttons,
// tinted tiles for the three lists, rows that light up under the cursor.
//
// Everything works with the mouse alone, and everything has a key. Every
// button's tooltip names its key.
//
//   Tabs        Tasks (grouped Today / Upcoming / No due date, or one list),
//               Completed, Archived.  Tab / Shift+Tab, h / l or Left / Right cycle.
//   Move        j/k or Up/Down
//   Space       complete a task, or restore it (Completed, Archived)
//   Enter, e    edit (the line is parsed again)        r  reschedule
//   d, Delete   delete: to Archived; in Archived, for good (press twice)
//   a           add          /  search      s  snooze all / resume
//   ,           settings     Esc  step back / close
//
// Everything shown is bound to the service; this file keeps view state only.
Panel {
  id: root
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var service: null
  // The bar knows the widget in its slot, not this nested panel; popout
  // bookkeeping must name that widget (see omarchy.clock).
  readonly property var barIdentity: hostWidget || root

  readonly property color foreground: bar ? bar.foreground : Commons.Color.foreground
  readonly property color urgent: bar ? bar.urgent : Commons.Color.urgent
  readonly property color accent: Commons.Color.accent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  function alpha(base, opacity) { return Qt.rgba(base.r, base.g, base.b, opacity) }

  // ------------------------------------------------------------- view state

  // "tasks", "done" or "archived".
  property string tab: "tasks"
  property bool settingsOpen: false
  property int cursor: 0
  property bool cursorActive: false
  // "", "add", "edit", "reschedule" or "search": which input line is open.
  property string mode: ""
  property string query: ""
  property int editId: 0
  property string inputText: ""
  property bool inputError: false
  // A delete waits for a second press on the same task.
  property int armedDeleteId: 0

  readonly property var tabs: ["tasks", "done", "archived"]
  readonly property var strings: service ? service.strings : null
  readonly property var appSettings: service ? service.settings : Model.settingsWith({})
  readonly property double now: service ? service.now : Date.now()
  readonly property bool snoozed: service ? service.snoozed : false

  readonly property var allTasks: service ? service.tasks : []
  readonly property var counts: {
    var bySection = service ? service.sections : Model.sections([], now)
    return { tasks: bySection.overdue.length + bySection.today.length + bySection.upcoming.length + bySection.nodate.length,
             done: bySection.done.length, archived: bySection.archived.length }
  }
  readonly property var filtered: Model.filterTasks(allTasks, query)
  // Rows of the current tab: group headers (Tasks, grouped) and tasks.
  readonly property var rows: buildRows(filtered, tab, appSettings.groupTasks, strings, now)
  readonly property var taskRows: rows.filter(function(row) { return row.kind === "task" })
  readonly property var selected: taskRows.length > 0 ? taskRows[Math.max(0, Math.min(cursor, taskRows.length - 1))].task : null
  // "", "title" or "due": the box the last save did not understand.
  property string formError: ""
  readonly property bool formOpen: mode === "add" || mode === "edit"
  // The Due box follows a date typed in the Task box until it is changed by
  // hand. originalDue is what it held when the form opened (empty when
  // adding), restored when the date words are taken out again.
  property bool dueManual: false
  property bool settingDue: false
  property string originalDue: ""

  function t(key) { return strings ? strings.t(key) : key }
  function tn(key, count) { return root.service ? root.service.plural(key, count) : String(count) }
  // "Edit (e)": a control's name with its key, for tooltips.
  function withKey(label, key) { return t("hint.withKey").arg(label).arg(key) }

  function buildRows(tasks, which, grouped, catalog, at) {
    var out = []
    var index = 0
    function push(list, group) {
      for (var i = 0; i < list.length; i++) out.push({ kind: "task", task: list[i], index: index++, group: group })
    }
    if (which === "tasks") {
      var groups = Model.taskGroups(tasks, at, grouped)
      groups.forEach(function(group) {
        if (group.key !== "all")
          out.push({ kind: "header", key: group.key, count: group.tasks.length,
                     label: catalog ? catalog.t("group." + group.key) : group.key })
        push(group.tasks, group.key)
      })
    } else {
      var bySection = Model.sections(tasks, at)
      push(which === "done" ? bySection.done : bySection.archived, which)
    }
    return out
  }

  // ------------------------------------------------------------ lifecycle

  onOpenedChanged: {
    if (!opened) return
    root.tab = "tasks"
    root.settingsOpen = false
    // The first task is selected on open, so the keys act on it at once.
    root.cursor = 0
    root.cursorActive = true
    root.mode = ""
    root.query = ""
    root.armedDeleteId = 0
    if (flick) flick.contentY = 0
    focusList()
  }

  onTaskRowsChanged: if (cursor >= taskRows.length) cursor = Math.max(0, taskRows.length - 1)
  onCursorChanged: scrollCursorIntoView()

  readonly property Item flick: panel.loadedContent ? panel.loadedContent.flick : null
  readonly property Item input: panel.loadedContent ? panel.loadedContent.input : null
  readonly property Item rowRepeater: panel.loadedContent ? panel.loadedContent.rowRepeater : null

  function focusList() {
    Qt.callLater(function() { if (panel.loadedContent) panel.loadedContent.forceActiveFocus() })
  }

  // --------------------------------------------------------------- actions

  function setTab(next) {
    if (root.tabs.indexOf(next) === -1) return
    root.tab = next
    root.settingsOpen = false
    root.cursor = 0
    root.cursorActive = true
    root.armedDeleteId = 0
    if (root.mode !== "search") root.mode = ""
    if (flick) flick.contentY = 0
  }

  function stepTab(delta) {
    var i = root.tabs.indexOf(root.tab)
    setTab(root.tabs[(i + delta + root.tabs.length) % root.tabs.length])
  }

  function moveCursor(dy) {
    root.armedDeleteId = 0
    if (root.settingsOpen) {
      if (flick) flick.contentY = Math.max(0, Math.min(flick.contentHeight - flick.height, flick.contentY + dy * Style.space(48)))
      return
    }
    if (!root.cursorActive) { root.cursorActive = true; return }
    if (taskRows.length === 0) return
    root.cursor = Math.max(0, Math.min(taskRows.length - 1, root.cursor + dy))
  }

  function focusTask(index) {
    root.cursorActive = true
    root.cursor = index
  }

  function scrollCursorIntoView() {
    if (!flick || !rowRepeater) return
    var rowIndex = -1
    for (var i = 0; i < rows.length; i++) if (rows[i].kind === "task" && rows[i].index === cursor) rowIndex = i
    var item = rowIndex >= 0 ? rowRepeater.itemAt(rowIndex) : null
    if (!item) return
    Qt.callLater(function() {
      var margin = Style.space(6)
      var top = item.mapToItem(flick.contentItem, 0, 0).y
      var bottom = top + item.height
      var maxY = Math.max(0, flick.contentHeight - flick.height)
      if (top < flick.contentY + margin) flick.contentY = Math.max(0, top - margin)
      else if (bottom > flick.contentY + flick.height - margin) flick.contentY = Math.min(maxY, bottom + margin - flick.height)
    })
  }

  // The add / edit form. Editing fills the boxes from the task: the Task box
  // never holds the date, which has its own box.
  function openForm(nextMode, task) {
    if (nextMode === "add" && root.tab !== "tasks") setTab("tasks")
    root.settingsOpen = false
    root.mode = nextMode
    root.editId = task ? task.id : 0
    root.formError = ""
    root.armedDeleteId = 0
    var content = panel.loadedContent
    if (!content) return
    // Due first: filling the Task box runs the auto-fill, which needs it.
    root.originalDue = task ? Parser.duePhrase(task, new Date()) : ""
    root.dueManual = false
    setDue(root.originalDue)
    content.titleField.text = task ? Parser.titlePhrase(task) : ""
    content.descField.text = task ? (task.description || "") : ""
    Qt.callLater(function() {
      var loaded = panel.loadedContent
      if (loaded) { loaded.titleField.forceActiveFocus(); loaded.titleField.cursorPosition = loaded.titleField.text.length }
    })
  }

  function setDue(text) {
    var content = panel.loadedContent
    if (!content || content.dueField.text === text) return
    root.settingDue = true
    content.dueField.text = text
    root.settingDue = false
  }

  // A date typed in the Task box fills the Due box; taking the date words out
  // again puts back what was there. Once the Due box is changed by hand, it
  // is left alone.
  function autoFillDue(titleText) {
    if (!service || !root.formOpen || root.dueManual) return
    var parsed = Parser.parse(titleText, new Date(), service.parserOptions())
    setDue(parsed.dueAt !== null ? Parser.duePhrase({ dueAt: parsed.dueAt, recur: parsed.recur }, new Date()) : root.originalDue)
  }

  function saveForm() {
    var content = panel.loadedContent
    if (!service || !content) return
    var err = service.saveForm(root.mode === "edit" ? root.editId : 0,
      content.titleField.text, content.dueField.text, content.descField.text)
    if (err !== "") {
      root.formError = err
      var field = err === "due" ? content.dueField : content.titleField
      field.forceActiveFocus()
      return
    }
    closeInput()
  }

  function openInput(nextMode, text, id) {
    root.settingsOpen = false
    root.mode = nextMode
    root.editId = id || 0
    root.inputError = false
    root.armedDeleteId = 0
    if (input) {
      input.text = text || ""
      root.inputText = input.text
      Qt.callLater(function() { if (root.input) { root.input.forceActiveFocus(); root.input.cursorPosition = root.input.text.length } })
    }
  }

  function closeInput() {
    var wasSearch = root.mode === "search"
    root.mode = ""
    root.inputError = false
    root.formError = ""
    if (!wasSearch) root.inputText = ""
    focusList()
  }

  function submitInput() {
    if (!service) return
    var text = root.inputText.trim()
    if (root.mode === "search") {
      // Keep the filter, give the keys back to the list.
      root.cursor = 0
      root.cursorActive = taskRows.length > 0
      closeInput()
      return
    }
    var ok = false
    if (root.mode === "reschedule") ok = service.reschedule(root.editId, text === "" ? "none" : text)
    if (!ok) { root.inputError = true; return }
    closeInput()
  }

  function stepBack() {
    if (root.armedDeleteId) { root.armedDeleteId = 0; return }
    if (root.settingsOpen) { root.settingsOpen = false; return }
    if (root.query !== "") { root.query = ""; root.inputText = ""; return }
    root.close()
  }

  function toggleSettings() {
    root.settingsOpen = !root.settingsOpen
    root.mode = ""
    root.armedDeleteId = 0
    if (flick) flick.contentY = 0
    focusList()
  }

  // Space / the check mark: complete an open task, restore one from
  // Completed or Archived.
  function primary(task) {
    if (!task || !service) return
    root.armedDeleteId = 0
    if (task.doneAt || task.archivedAt) service.restore(task.id)
    else service.complete(task.id)
  }

  function archive(task) {
    if (!task || !service || task.archivedAt) return
    root.armedDeleteId = 0
    service.archive(task.id)
  }

  // Delete moves a task to Archived, where it can be restored; only in
  // Archived does it delete for good, and that takes a second press.
  function deleteTask(task) {
    if (!task || !service) return
    if (!task.archivedAt) { archive(task); return }
    if (root.armedDeleteId === task.id) {
      root.armedDeleteId = 0
      service.remove(task.id)
    } else {
      root.armedDeleteId = task.id
    }
  }

  function startEdit(task) {
    if (!task || task.doneAt || task.archivedAt) return
    openForm("edit", task)
  }

  function startReschedule(task) {
    if (!task || task.doneAt || task.archivedAt) return
    openInput("reschedule", "", task.id)
  }

  function snoozeAll(minutes) {
    if (!service) return
    root.armedDeleteId = 0
    service.snoozeAll(minutes)
  }

  function toggleSnooze() {
    if (!service) return
    if (root.snoozed) service.resume()
    else snoozeAll(root.appSettings.snoozeMin)
  }

  // Apply now, and write it into the widget's shell.json entry so the bar
  // settings and the next start agree (the same path omarchy.clock takes).
  function changeSetting(key, value) {
    if (!service) return
    var values = {}
    values[key] = value
    service.applySettings(values)
    var host = root.hostWidget
    if (!host) return
    var id = host.moduleName || Model.PLUGIN_ID
    var entry = { id: id }
    for (var existing in host.settings) if (existing !== "id") entry[existing] = host.settings[existing]
    entry[key] = service.settings[key]
    host.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(id, entry)
  }

  // Row commands need a row: the first press of one shows the cursor.
  function onRow(fn) {
    if (root.settingsOpen) return
    if (!root.cursorActive) { root.cursorActive = taskRows.length > 0; return }
    fn(root.selected)
  }

  // The panel's keys. Omarchy's PanelKeyCatcher reads x as delete and Space
  // as activate; here Space completes, so the panel handles its own keys
  // (same structure, Left/Right through Util.readingKey so they follow
  // right-to-left layouts).
  function handleKey(event) {
    var shift = (event.modifiers & Qt.ShiftModifier) !== 0
    var text = event.text
    var key = Util.readingKey(event, true)

    if (event.key === Qt.Key_Escape) { stepBack(); return true }
    // Tab cycles the lists here (Omarchy panels otherwise move to the next
    // bar panel with it). In settings it leaves them for the lists.
    if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
      if (root.settingsOpen) root.settingsOpen = false
      else stepTab(shift || event.key === Qt.Key_Backtab ? -1 : 1)
      return true
    }
    if (event.key === Qt.Key_Down || text === "j") { moveCursor(1); return true }
    if (event.key === Qt.Key_Up || text === "k") { moveCursor(-1); return true }
    if (text === ",") { toggleSettings(); return true }
    if (text === "s") { toggleSnooze(); return true }
    if (root.settingsOpen) return false

    if (key === Qt.Key_Right || text === "l") { stepTab(1); return true }
    if (key === Qt.Key_Left || text === "h") { stepTab(-1); return true }
    if (text === "a") { openForm("add", null); return true }
    if (text === "/") { openInput("search", root.query, 0); return true }
    if (event.key === Qt.Key_Space) { onRow(primary); return true }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter || text === "e") {
      onRow(function(task) { if (root.tab === "tasks") startEdit(task); else primary(task) }); return true
    }
    if (text === "r") { onRow(startReschedule); return true }
    if (text === "d" || event.key === Qt.Key_Delete) { onRow(deleteTask); return true }
    return false
  }

  // ------------------------------------------------------------- the panel

  implicitWidth: 0
  implicitHeight: 0

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: false
    focusTarget: panel.loadedContent
    contentWidth: panel.fittedContentWidth(Style.space(400))
    contentHeight: panel.fittedContentHeight(panel.loadedContentHeight, Style.space(640))

    content: Item {
      id: keyCatcher
      property alias flick: flick
      property alias input: inputField
      property alias titleField: titleField
      property alias dueField: dueField
      property alias descField: descField
      property alias rowRepeater: rowRepeater

      anchors.fill: parent
      implicitHeight: column.implicitHeight
      focus: true

      // Keys go to an input or a settings field while one is being edited.
      readonly property bool editing: inputField.activeFocus || titleField.activeFocus
        || dueField.activeFocus || descField.activeFocus || settingsView.editing
      Keys.priority: Keys.BeforeItem
      Keys.onPressed: function(event) {
        if (keyCatcher.editing) return
        if (root.handleKey(event)) event.accepted = true
      }

      Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: column.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height

        Column {
          id: column
          width: flick.width
          spacing: Style.space(16)

          // ------------------------------------------------------ hero
          PanelHero {
            width: parent.width
            title: root.settingsOpen ? root.t("settings.title") : root.t("panel.title")
            meta: {
              if (!root.service) return root.t("widget.unavailable")
              if (root.snoozed) return root.t("snooze.until").arg(root.service.whenLabel(root.service.snoozedUntil))
              var summary = root.service.summary
              var parts = []
              if (summary.overdue > 0) parts.push(root.tn("widget.overdue", summary.overdue))
              if (summary.today > 0) parts.push(root.tn("widget.today", summary.today))
              return parts.length > 0 ? parts.join(" · ") : root.t("widget.idle")
            }
            foreground: root.foreground
            fontFamily: root.fontFamily

            iconComponent: Component {
              Text {
                textFormat: Text.PlainText
                text: Model.stateGlyph(root.service ? root.service.summary.state : "idle", root.snoozed)
                color: root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.display
              }
            }

            trailingControl: Component {
              Row {
                spacing: Style.space(6)

                HeroButton {
                  visible: !root.settingsOpen
                  glyph: String.fromCodePoint(0xF0415) // plus
                  tooltip: root.withKey(root.t("action.add"), "a")
                  onClicked: root.openForm("add", null)
                }

                HeroButton {
                  visible: !root.settingsOpen
                  glyph: String.fromCodePoint(root.snoozed ? 0xF040A : 0xF03E4) // play / pause
                  active: root.snoozed
                  tooltip: root.snoozed ? root.withKey(root.t("snooze.resume"), "s")
                    : root.withKey(root.t("snooze.for").arg(Model.shortDuration(root.appSettings.snoozeMin)), "s")
                  onClicked: root.toggleSnooze()
                }

                HeroButton {
                  glyph: String.fromCodePoint(root.settingsOpen ? 0xF004D : 0xF0493) // arrow-left / cog
                  tooltip: root.settingsOpen ? root.withKey(root.t("settings.back"), "Esc") : root.withKey(root.t("settings.title"), ",")
                  onClicked: root.toggleSettings()
                }
              }
            }
          }

          // A save that failed: why, and what to do about it.
          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: text !== ""
            text: root.service ? root.service.problem : ""
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          PanelSeparator { foreground: root.foreground }

          // ----------------------------------------------------- tabs
          Row {
            id: tabRow
            visible: !root.settingsOpen
            width: parent.width
            spacing: Style.space(8)

            Repeater {
              model: root.tabs

              TabTile {
                required property string modelData
                required property int index
                width: (tabRow.width - tabRow.spacing * 2) / 3
                key: modelData
              }
            }
          }

          // ------------------------------------------ add / edit form
          GridLayout {
            id: form
            width: parent.width
            visible: root.formOpen && !root.settingsOpen
            columns: 2
            columnSpacing: Style.space(12)
            rowSpacing: Style.space(6)

            FormLabel { text: root.t("form.task") }
            TextField {
              id: titleField
              Layout.fillWidth: true
              foreground: root.formError === "title" ? root.urgent : root.foreground
              placeholderText: root.mode === "add" ? root.t("panel.addPlaceholder") : root.t("form.taskPlaceholder")
              onTextChanged: {
                if (root.formError === "title") root.formError = ""
                root.autoFillDue(text)
              }
              onAccepted: root.saveForm()
              Keys.onEscapePressed: function(event) { root.closeInput(); event.accepted = true }
            }

            FormLabel { text: root.t("form.due") }
            TextField {
              id: dueField
              Layout.fillWidth: true
              foreground: root.formError === "due" ? root.urgent : root.foreground
              placeholderText: root.t("form.duePlaceholder")
              onTextChanged: {
                if (root.formError === "due") root.formError = ""
                if (!root.settingDue) root.dueManual = true
              }
              onAccepted: root.saveForm()
              Keys.onEscapePressed: function(event) { root.closeInput(); event.accepted = true }
            }

            // Only after a save the Due box held back: why, with examples.
            Item { visible: dueHint.visible; Layout.preferredWidth: 1; Layout.preferredHeight: 1 }
            FormHint {
              id: dueHint
              visible: root.formError === "due"
              warn: true
              text: root.t("form.dueNotRecognised")
            }

            FormLabel { text: root.t("form.description"); Layout.alignment: Qt.AlignTop; Layout.topMargin: Style.spacing.inputPaddingY }
            QQC.TextArea {
              id: descField
              readonly property var spec: Border.controlSpec(activeFocus ? "focus" : (hovered ? "hover-cursor" : "normal"), root.foreground, root.accent)
              Layout.fillWidth: true
              Layout.preferredHeight: Math.max(implicitHeight, Style.space(64))
              wrapMode: TextEdit.Wrap
              textFormat: TextEdit.PlainText
              color: root.foreground
              font.family: Style.font.family
              font.pixelSize: Style.font.body
              placeholderText: root.t("form.descriptionPlaceholder")
              placeholderTextColor: Qt.darker(root.foreground, 1.6)
              selectionColor: Style.selectionFillFor(root.foreground, root.accent)
              selectedTextColor: root.foreground
              leftPadding: Style.spacing.controlPaddingX + Border.left(spec)
              rightPadding: Style.spacing.controlPaddingX + Border.right(spec)
              topPadding: Style.spacing.inputPaddingY + Border.top(spec)
              bottomPadding: Style.spacing.inputPaddingY + Border.bottom(spec)
              KeyNavigation.tab: titleField
              KeyNavigation.backtab: dueField
              background: BorderSurface {
                color: Style.controlFill(descField.activeFocus, descField.hovered, root.foreground, root.accent)
                borderSpec: descField.spec
                radius: Style.cornerRadius
              }
              // Enter starts a new line; Ctrl+Enter saves, Esc cancels.
              Keys.onPressed: function(event) {
                if (event.key === Qt.Key_Escape) { root.closeInput(); event.accepted = true }
                else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
                  root.saveForm(); event.accepted = true
                }
              }
            }

            Item { Layout.preferredWidth: 1; Layout.preferredHeight: 1 }
            RowLayout {
              Layout.fillWidth: true
              spacing: Style.space(6)

              FormHint {
                Layout.fillWidth: true
                warn: root.formError === "title" || root.formError === "storage"
                text: root.formError === "title" ? root.t("form.titleMissing")
                  : root.formError === "storage" ? root.t("form.saveFailed")
                  : ""
              }

              ActionLink {
                glyph: String.fromCodePoint(0xF012C) // check
                label: root.t("form.save")
                keyName: root.t("key.enter")
                onClicked: root.saveForm()
              }

              ActionLink {
                glyph: String.fromCodePoint(0xF0156) // close
                label: root.t("form.cancel")
                keyName: "Esc"
                onClicked: root.closeInput()
              }
            }
          }

          // -------------------------------------- reschedule / search
          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: (root.mode === "reschedule" || root.mode === "search") && !root.settingsOpen

            TextField {
              id: inputField
              width: parent.width
              foreground: root.inputError ? root.urgent : root.foreground
              placeholderText: root.mode === "reschedule" ? root.t("panel.reschedulePlaceholder") : root.t("panel.searchPlaceholder")
              onTextChanged: {
                root.inputText = text
                root.inputError = false
                if (root.mode === "search") { root.query = text; root.cursor = 0 }
              }
              onAccepted: root.submitInput()
              Keys.onEscapePressed: function(event) {
                if (root.mode === "search") { root.query = ""; root.inputText = "" }
                root.closeInput()
                event.accepted = true
              }
            }

            Text {
              textFormat: Text.PlainText
              width: parent.width
              visible: text !== ""
              // Only when a reschedule was not understood.
              text: !root.inputError ? ""
                : root.service && root.service.problem !== "" ? root.t("form.saveFailed")
                : root.t("panel.notUnderstood")
              color: root.inputError ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          // A search kept after Enter: what it is, and how to clear it.
          RowLayout {
            width: parent.width
            visible: root.mode === "" && root.query !== "" && !root.settingsOpen
            spacing: Style.space(8)

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              text: root.t("panel.search") + ": " + root.query
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }

            TextLink {
              text: root.t("panel.clearSearch")
              tooltip: root.withKey(root.t("panel.clearSearch"), "Esc")
              onClicked: { root.query = ""; root.inputText = "" }
            }
          }

          // ----------------------------------------------------- list
          Column {
            width: parent.width
            spacing: Style.space(4)
            visible: !root.settingsOpen

            Repeater {
              id: rowRepeater
              model: root.rows

              Loader {
                required property var modelData
                width: parent ? parent.width : 0
                sourceComponent: modelData.kind === "header" ? groupHeader : taskRow
                onLoaded: item.row = modelData
                onModelDataChanged: if (item) item.row = modelData
              }
            }
          }

          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: !root.settingsOpen && root.taskRows.length === 0
            topPadding: Style.space(8)
            bottomPadding: Style.space(8)
            horizontalAlignment: Text.AlignHCenter
            text: root.query !== "" ? root.t("panel.noMatch") : root.t("empty." + root.tab)
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.body
            wrapMode: Text.WordWrap
          }

          // How long tasks stay in this list, from the settings.
          Text {
            textFormat: Text.PlainText
            width: parent.width
            visible: !root.settingsOpen && text !== ""
            horizontalAlignment: Text.AlignHCenter
            text: {
              if (root.tab === "done")
                return root.appSettings.keepDoneDays > 0 ? root.tn("lifecycle.done", root.appSettings.keepDoneDays) : root.t("lifecycle.doneKept")
              if (root.tab === "archived")
                return root.appSettings.keepArchivedDays > 0 ? root.tn("lifecycle.archived", root.appSettings.keepArchivedDays) : root.t("lifecycle.archivedKept")
              return ""
            }
            color: root.dim
            font.family: root.fontFamily
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
          }

          // ------------------------------------------------- settings
          // Loaded by URL: Quickshell does not resolve sibling files of an
          // installed plugin as types. Built the first time settings open.
          Loader {
            id: settingsView
            readonly property bool editing: item ? item.editing === true : false
            width: parent.width
            visible: root.settingsOpen
            active: root.settingsOpen || status === Loader.Ready
            source: Qt.resolvedUrl("SettingsView.qml")
            onEditingChanged: if (!editing) keyCatcher.forceActiveFocus()

            Binding { target: settingsView.item; property: "width"; value: settingsView.width; when: settingsView.item !== null }
            Binding { target: settingsView.item; property: "service"; value: root.service; when: settingsView.item !== null }
            Binding { target: settingsView.item; property: "foreground"; value: root.foreground; when: settingsView.item !== null }
            Binding { target: settingsView.item; property: "dim"; value: root.dim; when: settingsView.item !== null }
            Binding { target: settingsView.item; property: "urgent"; value: root.urgent; when: settingsView.item !== null }
            Binding { target: settingsView.item; property: "fontFamily"; value: root.fontFamily; when: settingsView.item !== null }

            Connections {
              target: settingsView.item
              function onChangeRequested(key, value) { root.changeSetting(key, value) }
            }
          }
        }
      }
    }
  }

  // --------------------------------------------------------------- parts

  // The tinted square in the hero's corner (as in the Agents panel).
  component HeroButton: Rectangle {
    id: heroButton
    signal clicked()
    property string glyph: ""
    property string tooltip: ""
    property bool active: false
    readonly property bool hot: heroMouse.containsMouse
    implicitWidth: Style.space(34)
    implicitHeight: implicitWidth
    radius: Style.cornerRadius
    color: root.alpha(root.accent, hot || active ? 0.3 : 0.12)
    border.width: hot ? Math.max(1, Style.hoverBorderWidth) : 0
    border.color: root.accent

    Text {
      anchors.centerIn: parent
      textFormat: Text.PlainText
      text: heroButton.glyph
      color: root.accent
      font.family: root.fontFamily
      font.pixelSize: Style.font.heading
    }

    MouseArea {
      id: heroMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: heroButton.clicked()
    }

    PanelToolTip {
      visible: heroMouse.containsMouse
      text: heroButton.tooltip
    }
  }

  // One of the three lists, as a tinted tile (the Agents panel's starter
  // tiles): name and count, accent when current.
  component TabTile: Rectangle {
    id: tile
    property string key: ""
    readonly property bool current: root.tab === key
    readonly property bool hot: tileMouse.containsMouse
    implicitHeight: tileBody.implicitHeight + Style.space(16)
    radius: Style.cornerRadius
    color: current ? root.alpha(root.accent, 0.14) : root.alpha(root.foreground, hot ? 0.09 : 0.05)

    Row {
      id: tileBody
      anchors.centerIn: parent
      spacing: Style.space(6)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: root.t("tab." + tile.key)
        color: tile.current ? root.accent : root.foreground
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
        font.bold: true
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: Commons.I18n.formatNumber(root.counts[tile.key] || 0)
        color: tile.current ? root.accent : root.dim
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }
    }

    MouseArea {
      id: tileMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: root.setTab(tile.key)
    }

    PanelToolTip {
      visible: tileMouse.containsMouse
      text: root.withKey(root.t("tab." + tile.key), root.t("key.tab"))
    }
  }

  // A plain-text control: dim until hovered (the Agents panel's TextLink).
  component TextLink: Text {
    id: link
    signal clicked()
    property string tooltip: ""
    textFormat: Text.PlainText
    color: linkMouse.containsMouse ? root.foreground : root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.underline: linkMouse.containsMouse

    MouseArea {
      id: linkMouse
      anchors.fill: parent
      anchors.margins: -Style.space(4)
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: link.clicked()
    }

    PanelToolTip {
      visible: link.tooltip !== "" && linkMouse.containsMouse
      text: link.tooltip
    }
  }

  // A box's name in the add / edit form.
  component FormLabel: Text {
    textFormat: Text.PlainText
    Layout.alignment: Qt.AlignVCenter
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
  }

  // A live line under a form box: what it reads as, or why it was refused.
  component FormHint: Text {
    property bool warn: false
    textFormat: Text.PlainText
    Layout.fillWidth: true
    color: warn ? root.urgent : root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    elide: Text.ElideRight
  }

  // An action in the selected task's footer: icon, name, and its key in a
  // small keycap, centred in a cell that is clickable across its width.
  component ActionLink: Item {
    id: link
    signal clicked()
    property string glyph: ""
    property string label: ""
    property string keyName: ""
    property bool warn: false
    readonly property bool hot: linkMouse.containsMouse
    readonly property color tone: warn ? root.urgent : hot ? root.accent : root.foreground

    implicitWidth: linkRow.implicitWidth + Style.space(12)
    implicitHeight: linkRow.implicitHeight + Style.space(8)

    Rectangle {
      anchors.fill: parent
      radius: Style.cornerRadius
      visible: link.hot
      color: root.alpha(link.warn ? root.urgent : root.accent, 0.12)
    }

    Row {
      id: linkRow
      anchors.centerIn: parent
      spacing: Style.space(6)

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: link.glyph
        color: link.tone
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      Text {
        anchors.verticalCenter: parent.verticalCenter
        textFormat: Text.PlainText
        text: link.label
        color: link.tone
        font.family: root.fontFamily
        font.pixelSize: Style.font.caption
      }

      Rectangle {
        anchors.verticalCenter: parent.verticalCenter
        width: keyText.implicitWidth + Style.space(8)
        height: keyText.implicitHeight + Style.space(2)
        radius: Math.min(Style.cornerRadius, height / 2)
        color: root.alpha(root.foreground, 0.08)

        Text {
          id: keyText
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: link.keyName
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }
      }
    }

    MouseArea {
      id: linkMouse
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: link.clicked()
    }
  }

  Component {
    id: groupHeader

    Item {
      property var row: null
      implicitHeight: headerText.implicitHeight + Style.space(8)

      PanelSectionHeader {
        id: headerText
        anchors.left: parent.left
        anchors.bottom: parent.bottom
        anchors.bottomMargin: Style.space(2)
        text: row ? row.label + "  " + Commons.I18n.formatNumber(row.count) : ""
        foreground: root.foreground
        fontFamily: root.fontFamily
      }
    }
  }

  // A task: check mark, title with its repeat and tags underneath, and the
  // due time with how far away it is on the right. The selected task gets a
  // footer across its full width with its actions and their keys. Hovering only highlights:
  // a row that grew under the pointer would shift the rows beneath it.
  Component {
    id: taskRow

    CursorSurface {
      id: rowSurface
      property var row: null
      readonly property var task: row ? row.task : null
      readonly property bool done: !!(task && task.doneAt)
      readonly property bool archived: !!(task && task.archivedAt)
      readonly property bool closed: done || archived
      readonly property bool overdue: !!task && !closed && task.dueAt !== null && task.dueAt <= root.now
      readonly property bool armed: !!task && root.armedDeleteId === task.id
      readonly property bool showActions: hasCursor

      // Right column: when it was due, completed or archived, and how far off.
      readonly property string whenText: {
        if (!task || !root.service) return ""
        if (archived) return root.service.shortWhen(task.archivedAt)
        if (done) return root.service.shortWhen(task.doneAt)
        if (task.dueAt === null) return ""
        return root.service.shortWhen(task.dueAt)
      }
      readonly property string distanceText: {
        if (!task || !root.service) return ""
        if (archived) return root.t("meta.archivedShort")
        if (done) return root.t("meta.completedShort")
        return task.dueAt === null ? "" : root.service.shortRelativeLabel(task.dueAt)
      }
      // Left, under the title: repeat and tags, or the delete prompt.
      readonly property string detailText: {
        if (!task || !root.service) return ""
        if (armed) return root.t("panel.confirmDelete")
        var parts = []
        if (task.recur && !closed) parts.push(root.service.recurLabel(task.recur))
        for (var i = 0; i < task.tags.length; i++) parts.push("#" + task.tags[i])
        // Has a description: marked here; shown in full when selected.
        var mark = task.description && !showActions ? String.fromCodePoint(0xF09A8) : ""
        return (mark + (mark && parts.length ? "  " : "") + parts.join("  ·  "))
      }

      hasCursor: root.cursorActive && row !== null && root.cursor === row.index
      foreground: root.foreground
      implicitHeight: body.implicitHeight + Style.space(14)

      HoverHandler {
        id: hover
        cursorShape: Qt.PointingHandCursor
      }

      TapHandler {
        acceptedButtons: Qt.LeftButton
        onTapped: if (rowSurface.row) root.focusTask(rowSurface.row.index)
        onDoubleTapped: root.startEdit(rowSurface.task)
      }

      // A lighter wash under the pointer than the selection's.
      Rectangle {
        anchors.fill: parent
        radius: Style.cornerRadius
        visible: hover.hovered && !rowSurface.hasCursor
        color: root.alpha(root.foreground, 0.04)
      }

      // The task, and under it (selected only) the footer with its actions.
      ColumnLayout {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(10)
        anchors.rightMargin: Style.space(10)
        spacing: Style.space(8)

        RowLayout {
          id: rowLayout
          Layout.fillWidth: true
          spacing: Style.space(12)

          // Check mark: completes an open task, restores a closed one.
          Text {
            id: check
            textFormat: Text.PlainText
            text: String.fromCodePoint(rowSurface.archived ? 0xF0A7A : rowSurface.done ? 0xF0133 : 0xF0130)
            color: checkMouse.containsMouse ? root.accent : rowSurface.overdue ? root.urgent : rowSurface.closed ? root.dim : root.foreground
            font.family: root.fontFamily
            font.pixelSize: Style.font.icon
            Layout.alignment: Qt.AlignTop
            Layout.topMargin: Math.max(0, (titleMetrics.height - implicitHeight) / 2)

            MouseArea {
              id: checkMouse
              anchors.fill: parent
              anchors.margins: -Style.space(6)
              hoverEnabled: true
              cursorShape: Qt.PointingHandCursor
              onClicked: root.primary(rowSurface.task)
            }

            PanelToolTip {
              visible: checkMouse.containsMouse
              text: root.withKey(rowSurface.closed ? root.t("action.restore") : root.t("action.complete"), root.t("key.space"))
            }
          }

          // Title, and underneath it the repeat and tags.
          ColumnLayout {
            Layout.fillWidth: true
            Layout.alignment: Qt.AlignTop
            spacing: Style.space(2)

            RowLayout {
              Layout.fillWidth: true
              spacing: Style.space(6)

              Text {
                textFormat: Text.PlainText
                visible: !!rowSurface.task && rowSurface.task.priority > 0
                text: rowSurface.task ? "!" + rowSurface.task.priority : ""
                color: root.accent
                font.family: root.fontFamily
                font.pixelSize: Style.font.caption
                font.bold: true
                Layout.alignment: Qt.AlignTop
                // On the title's first line.
                Layout.topMargin: Math.max(0, (titleMetrics.height - implicitHeight) / 2)
              }

              // All the room up to the due column; long titles wrap (up to
              // three lines, then elide).
              Text {
                id: titleText
                textFormat: Text.PlainText
                Layout.fillWidth: true
                Layout.alignment: Qt.AlignTop
                text: rowSurface.task ? rowSurface.task.title : ""
                color: rowSurface.closed ? root.dim : root.foreground
                font.family: root.fontFamily
                font.pixelSize: Style.font.body
                font.strikeout: rowSurface.done
                wrapMode: Text.Wrap
                maximumLineCount: 3
                elide: Text.ElideRight
              }

              FontMetrics {
                id: titleMetrics
                font: titleText.font
              }
            }

            Text {
              textFormat: Text.PlainText
              Layout.fillWidth: true
              visible: text !== ""
              text: rowSurface.detailText
              color: rowSurface.armed ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
              elide: Text.ElideRight
            }
          }

          // When it is due (or was completed or archived), and how far off.
          Column {
            id: dueColumn
            Layout.alignment: Qt.AlignTop
            visible: rowSurface.whenText !== "" || rowSurface.distanceText !== ""
            spacing: Style.space(2)

            Text {
              anchors.right: parent.right
              textFormat: Text.PlainText
              text: rowSurface.whenText
              visible: text !== ""
              color: rowSurface.overdue ? root.urgent : rowSurface.closed ? root.dim : root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              font.features: { "tnum": 1 }
            }

            Text {
              anchors.right: parent.right
              textFormat: Text.PlainText
              text: rowSurface.distanceText
              visible: text !== ""
              color: rowSurface.overdue ? root.urgent : root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }
          }
        }

        // The description, on the selected task only, under the title.
        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          Layout.leftMargin: check.width + rowLayout.spacing
          visible: rowSurface.showActions && !!rowSurface.task && rowSurface.task.description !== ""
          text: rowSurface.task ? rowSurface.task.description : ""
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          wrapMode: Text.Wrap
          maximumLineCount: 8
          elide: Text.ElideRight
        }

        // Footer of the selected task: a divider, then its actions spread
        // across the full width, each with its key. Cells take their content's
        // width plus an even share of the rest; a whole cell is clickable.
        Rectangle {
          Layout.fillWidth: true
          Layout.preferredHeight: 1
          visible: rowSurface.showActions
          color: root.alpha(root.foreground, 0.1)
        }

        RowLayout {
          Layout.fillWidth: true
          visible: rowSurface.showActions
          spacing: 0

          ActionLink {
            visible: !rowSurface.closed
            Layout.fillWidth: true
            glyph: String.fromCodePoint(0xF03EB) // pencil
            label: root.t("action.edit")
            keyName: "e"
            onClicked: root.startEdit(rowSurface.task)
          }

          ActionLink {
            visible: !rowSurface.closed
            Layout.fillWidth: true
            glyph: String.fromCodePoint(0xF00F0) // calendar-clock
            label: root.t("action.reschedule")
            keyName: "r"
            onClicked: root.startReschedule(rowSurface.task)
          }

          ActionLink {
            visible: rowSurface.closed
            Layout.fillWidth: true
            glyph: String.fromCodePoint(0xF054C) // undo
            label: root.t("action.restore")
            keyName: root.t("key.space")
            onClicked: root.primary(rowSurface.task)
          }

          ActionLink {
            Layout.fillWidth: true
            glyph: String.fromCodePoint(0xF0A7A) // trash-can-outline
            label: rowSurface.archived ? root.t("action.deleteForever") : root.t("action.delete")
            keyName: "d"
            warn: rowSurface.armed
            onClicked: root.deleteTask(rowSurface.task)
          }
        }
      }
    }
  }
}
