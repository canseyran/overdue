import QtQuick
import QtQuick.Layouts
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Overdue's settings, inside the task panel (open with the gear or ",").
// Every row has the same shape: a title and a short description on the left,
// the control in a fixed-width column on the right, so all controls line up.
// Descriptions with an example fill it in from the current value.
//
// Tab / Shift+Tab walk every control top to bottom. A switch toggles with
// Space or Enter; a choice group walks its chips with h / l or Left / Right
// and picks with Space or Enter; number and text fields take typing.
//
// Changes go out through changeRequested; TaskPanel writes them to the
// service and to the widget's shell.json entry, so the bar settings show the
// same values.
Column {
  id: root

  property var service: null
  property color foreground: Commons.Color.foreground
  property color dim: Qt.darker(foreground, 1.55)
  property color urgent: Commons.Color.urgent
  property string fontFamily: Style.font.family

  // True while a field has the keyboard, so the panel's keys stand down.
  readonly property bool editing: {
    for (var i = 0; i < root.fields.length; i++) if (root.fields[i].editing) return true
    return false
  }
  property var fields: []

  signal changeRequested(string key, var value)

  readonly property var settings: service ? service.settings : Model.settingsWith({})
  readonly property real controlWidth: Style.spacing.numberFieldWidth

  function t(key) { return service ? service.strings.t(key) : key }

  // The description for a setting, with its example filled in from the
  // current value.
  function describe(key) {
    var text = root.t("settings." + key + ".desc")
    if (text === "settings." + key + ".desc") return ""
    var value = root.settings[key]
    var example = ""
    if (key === "nagEveryMin") example = Model.repeatExample(9 * 60, Number(value) || 1, 3)
    else if (key === "remindAheadMin") example = Number(value) > 0
      ? Model.formatClock((9 * 60 - Number(value) + 1440) % 1440) + " " + root.t("settings.and") + " 09:00" : "09:00"
    else if (/Hour$/.test(key)) example = Model.formatClock((Number(value) || 0) * 60)
    return example !== "" ? text.replace("%1", example) : text
  }

  spacing: Style.space(10)

  Section { text: root.t("settings.reminders") }
  NumberRow { key: "nagEveryMin"; from: 1; to: 1440 }
  NumberRow { key: "remindAheadMin"; from: 0; to: 1440 }
  NumberRow { key: "snoozeMin"; from: 1; to: 10080 }
  TextRow {
    key: "reviewTime"
    function valid(text) { return text === "" || Model.parseClock(text) !== null }
  }
  TextRow {
    key: "quietHours"
    function valid(text) { return text === "" || Model.parseQuietHours(text) !== null }
  }

  ToggleRow { key: "hideTitles" }

  Section { text: root.t("settings.dates") }
  NumberRow { key: "defaultHour"; from: 0; to: 23 }
  NumberRow { key: "morningHour"; from: 0; to: 23 }
  NumberRow { key: "afternoonHour"; from: 0; to: 23 }
  NumberRow { key: "eveningHour"; from: 0; to: 23 }
  NumberRow { key: "nightHour"; from: 0; to: 23 }
  ToggleRow { key: "bareHoursPm" }
  ChoiceRow { key: "weekStart"; choices: ["monday", "sunday"] }
  ChoiceRow { key: "endOfWeek"; choices: ["friday", "last"] }

  Section { text: root.t("settings.lists") }
  ToggleRow { key: "groupTasks" }
  NumberRow { key: "keepDoneDays"; from: 0; to: 3650 }
  NumberRow { key: "keepArchivedDays"; from: 0; to: 3650 }

  Section { text: root.t("settings.display") }
  ToggleRow { key: "showCount" }

  // ---------------------------------------------------------------- parts

  component Section: Item {
    property alias text: header.text
    width: root.width
    implicitHeight: header.implicitHeight + Style.space(6)

    PanelSectionHeader {
      id: header
      anchors.left: parent.left
      anchors.bottom: parent.bottom
      foreground: root.foreground
      fontFamily: root.fontFamily
    }
  }

  // Title and description: the left side of every row.
  component Caption: ColumnLayout {
    property string key: ""
    property bool invalid: false

    Layout.fillWidth: true
    Layout.alignment: Qt.AlignTop
    spacing: Style.space(2)

    Text {
      textFormat: Text.PlainText
      Layout.fillWidth: true
      text: root.t("settings." + parent.key)
      color: root.foreground
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
      wrapMode: Text.WordWrap
    }

    Text {
      textFormat: Text.PlainText
      Layout.fillWidth: true
      visible: text !== ""
      text: parent.invalid ? root.t("settings.invalid") : root.describe(parent.key)
      color: parent.invalid ? root.urgent : root.dim
      font.family: root.fontFamily
      font.pixelSize: Style.font.caption
      wrapMode: Text.WordWrap
    }
  }

  // The right side of every row: same width for every control, aligned to
  // the row's right edge and its first line.
  component Control: Item {
    default property alias content: holder.data
    Layout.preferredWidth: root.controlWidth
    Layout.alignment: Qt.AlignTop
    implicitHeight: holder.childrenRect.height

    Item {
      id: holder
      anchors.fill: parent
    }
  }

  component NumberRow: RowLayout {
    id: numberRow
    property string key: ""
    property int from: 0
    property int to: 100
    readonly property bool editing: number.field.activeFocus

    width: root.width
    spacing: Style.space(12)
    Component.onCompleted: root.fields = root.fields.concat([numberRow])

    Caption { key: numberRow.key }

    Control {
      NumberField {
        id: number
        anchors.right: parent.right
        fieldWidth: root.controlWidth
        foreground: root.foreground
        fontFamily: root.fontFamily
        from: numberRow.from
        to: numberRow.to
        value: Number(root.settings[numberRow.key]) || 0
        onModified: function(value) { if (value !== root.settings[numberRow.key]) root.changeRequested(numberRow.key, value) }
        // Esc drops what was typed and gives the keys back to the panel, as
        // in the text rows; a second Esc leaves settings.
        Keys.onEscapePressed: function(event) {
          var spin = number.field
          if (spin.contentItem) spin.contentItem.text = spin.textFromValue(spin.value, spin.locale)
          spin.focus = false
          event.accepted = true
        }
      }
    }
  }

  component ToggleRow: RowLayout {
    id: toggleRow
    property string key: ""
    readonly property bool editing: false

    width: root.width
    spacing: Style.space(12)

    Caption { key: toggleRow.key }

    Control {
      // Sized to the track plus the focus ring's room on the sides, so the
      // ring neither moves the switch, grows the row, nor gets clipped at
      // the panel's edge.
      Item {
        anchors.right: parent.right
        width: toggle.trackWidth + toggle.cursorPad * 2
        height: toggle.trackHeight

        ToggleSwitch {
          id: toggle
          anchors.centerIn: parent
          activeFocusOnTab: true
          cursorRing: activeFocus
          hasCursor: activeFocus
          checked: root.settings[toggleRow.key] === true
          foreground: root.foreground
          onToggled: root.changeRequested(toggleRow.key, root.settings[toggleRow.key] !== true)
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Space || event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
              toggle.toggled()
              event.accepted = true
            }
          }
        }
      }
    }
  }

  // One of a few values, as Omarchy's segmented ButtonGroup.
  component ChoiceRow: RowLayout {
    id: choiceRow
    property string key: ""
    property var choices: []
    readonly property bool editing: false

    width: root.width
    spacing: Style.space(12)

    Caption { key: choiceRow.key }

    ButtonGroup {
      Layout.alignment: Qt.AlignTop
      focusable: true
      foreground: root.foreground
      fontFamily: root.fontFamily
      fontSize: Style.font.caption
      options: choiceRow.choices.map(function(choice) { return { value: choice, label: root.t("option." + choice) } })
      value: String(root.settings[choiceRow.key] || "")
      onChanged: function(value) { if (value !== root.settings[choiceRow.key]) root.changeRequested(choiceRow.key, value) }
    }
  }

  // Free text, applied on Enter or when the field loses focus. A value that
  // does not parse is refused, and the description says so.
  component TextRow: RowLayout {
    id: textRow
    property string key: ""
    property bool invalid: false
    readonly property bool editing: field.activeFocus
    function valid(text) { return true }

    function commit() {
      var text = field.text.trim()
      if (text === String(root.settings[textRow.key] || "")) { textRow.invalid = false; return }
      if (!textRow.valid(text)) { textRow.invalid = true; return }
      textRow.invalid = false
      root.changeRequested(textRow.key, text)
    }

    width: root.width
    spacing: Style.space(12)
    Component.onCompleted: root.fields = root.fields.concat([textRow])

    Caption { key: textRow.key; invalid: textRow.invalid }

    Control {
      TextField {
        id: field
        anchors.left: parent.left
        anchors.right: parent.right
        foreground: textRow.invalid ? root.urgent : root.foreground
        text: String(root.settings[textRow.key] || "")
        // A sample value, not a label.
        placeholderText: root.t("settings." + textRow.key + ".placeholder")
        horizontalAlignment: TextInput.AlignHCenter
        onAccepted: { textRow.commit(); field.focus = false }
        onActiveFocusChanged: if (!activeFocus) textRow.commit()
        Keys.onEscapePressed: function(event) {
          field.text = String(root.settings[textRow.key] || "")
          textRow.invalid = false
          field.focus = false
          event.accepted = true
        }
      }
    }
  }
}
