import QtQuick
import QtQuick.Layouts
import Quickshell
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Quick add (QA-1..QA-5): one line, summoned from anywhere with
//   omarchy-shell shell summon canseyran.overdue '{}'
// It opens focused, shows what the parser read before saving, and never
// animates: it opens many times a day (keepLoaded keeps it instant).
//
// Enter saves and closes, Shift+Enter saves and stays open for the next
// task, Esc clears the line or closes.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string pluginId: (manifest && manifest.id) || Model.PLUGIN_ID

  property bool opened: false
  property string text: ""
  // The last task saved while staying open, echoed under the line.
  property string savedTitle: ""
  // The last Enter could not save; the line is kept so nothing is lost.
  property bool notSaved: false

  property var service: null
  readonly property var strings: service ? service.strings : null
  readonly property var preview: service && text.trim() !== "" ? service.preview(text) : null
  // Tags or a priority: one line of the preview.
  readonly property bool previewHasMeta: !!preview && (preview.tags.length > 0 || preview.priority > 0)

  function t(key) { return strings ? strings.t(key) : key }

  readonly property color background: Commons.Color.menu.background
  readonly property color foreground: Commons.Color.menu.text
  readonly property color dim: Qt.darker(foreground, 1.5)
  readonly property var borderSpec: Border.surfaceSpec("menu", "border", Commons.Color.menu.border, Math.max(1, Style.space(2)))
  readonly property string fontFamily: Style.font.menuFamily

  function findService() {
    if (!root.service && root.shell && typeof root.shell.serviceFor === "function")
      root.service = root.shell.serviceFor(root.pluginId)
    return root.service
  }

  onShellChanged: findService()

  function open(payloadJson) {
    findService()
    root.text = ""
    root.savedTitle = ""
    root.notSaved = false
    input.text = ""
    root.opened = true
    Qt.callLater(function() { input.forceActiveFocus() })
  }

  function close() {
    root.opened = false
  }

  function dismiss() {
    root.opened = false
    if (root.shell && typeof root.shell.hide === "function") root.shell.hide(root.pluginId)
  }

  function toggle() {
    if (root.opened) root.dismiss()
    else root.open("{}")
  }

  function submit(stayOpen) {
    var line = root.text.trim()
    if (line === "") {
      if (!stayOpen) root.dismiss()
      return
    }
    if (!findService()) return
    var title = root.preview ? root.preview.title : line
    var id = root.service.add(line)
    root.notSaved = !id
    if (!id) return
    if (stayOpen) {
      root.savedTitle = title
      input.text = ""
    } else {
      root.dismiss()
    }
  }

  OverlayWindow {
    id: overlay
    shown: root.opened
    WlrLayershell.namespace: "overdue-quick-add"

    Rectangle {
      anchors.fill: parent
      color: Commons.Color.menu.scrim
    }

    MouseArea {
      anchors.fill: parent
      onClicked: root.dismiss()
    }

    BorderSurface {
      id: card
      width: Math.min(Style.space(560), overlay.width - Style.gapsOut * 2)
      height: content.implicitHeight + card.contentTopInset + card.contentBottomInset
      anchors.horizontalCenter: parent.horizontalCenter
      y: Math.round(overlay.height * 0.28)
      radius: Style.cornerRadius
      color: root.background
      borderSpec: root.borderSpec
      padding: Style.spacing.panelPadding

      MouseArea { anchors.fill: parent; onClicked: input.forceActiveFocus() }

      ColumnLayout {
        id: content
        anchors.fill: parent
        anchors.topMargin: card.contentTopInset
        anchors.rightMargin: card.contentRightInset
        anchors.bottomMargin: card.contentBottomInset
        anchors.leftMargin: card.contentLeftInset
        spacing: Style.space(8)

        TextField {
          id: input
          Layout.fillWidth: true
          foreground: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.heading
          placeholderText: root.t("quickAdd.placeholder")
          onTextChanged: root.text = text

          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Escape) {
              if (input.text !== "") input.text = ""
              else root.dismiss()
              event.accepted = true
            } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
              root.submit((event.modifiers & Qt.ShiftModifier) !== 0)
              event.accepted = true
            }
          }
        }

        // Live preview of the parse (QA-4).
        GridLayout {
          Layout.fillWidth: true
          visible: root.preview !== null
          columns: 2
          columnSpacing: Style.space(12)
          rowSpacing: Style.space(2)

          PreviewLabel { text: root.t("preview.title") }
          PreviewValue { text: root.preview ? root.preview.title : "" }

          PreviewLabel { text: String.fromCodePoint(0xF00F0) } // calendar-clock
          PreviewValue {
            text: !root.preview ? ""
              : root.preview.when ? root.preview.when + "  ·  " + root.preview.relative
              : root.t("preview.noDate")
            opacity: root.preview && root.preview.when ? 1 : 0.6
          }

          PreviewLabel { visible: !!root.preview && root.preview.recur !== ""; text: String.fromCodePoint(0xF0456) } // repeat
          PreviewValue { visible: !!root.preview && root.preview.recur !== ""; text: root.preview ? root.preview.recur : "" }

          PreviewLabel { visible: root.previewHasMeta; text: String.fromCodePoint(0xF04F9) } // tag
          PreviewValue {
            visible: root.previewHasMeta
            text: {
              var preview = root.preview
              if (!preview) return ""
              var parts = preview.tags.map(function(tag) { return "#" + tag })
              if (preview.priority > 0) parts.push("!" + preview.priority)
              return parts.join("  ")
            }
          }

          PreviewLabel { visible: !!root.preview && root.preview.description !== ""; text: String.fromCodePoint(0xF09A8) } // text
          PreviewValue {
            visible: !!root.preview && root.preview.description !== ""
            text: root.preview ? root.preview.description : ""
            wrapMode: Text.Wrap
            maximumLineCount: 3
          }
        }

        // A save that failed: that it did, why, and what to do about it.
        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          visible: text !== ""
          text: {
            var problem = root.service ? root.service.problem : ""
            if (root.notSaved) return root.t("quickAdd.notSaved") + (problem ? ". " + problem : "")
            return problem
          }
          color: Commons.Color.urgent
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          visible: root.savedTitle !== "" && !root.notSaved
          text: root.t("quickAdd.saved") + ": " + root.savedTitle
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }

        Text {
          textFormat: Text.PlainText
          Layout.fillWidth: true
          text: root.service ? root.t("quickAdd.hint") : root.t("widget.unavailable")
          color: root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
        }
      }
    }
  }

  component PreviewLabel: Text {
    textFormat: Text.PlainText
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }

  component PreviewValue: Text {
    textFormat: Text.PlainText
    Layout.fillWidth: true
    color: root.foreground
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
    elide: Text.ElideRight
  }
}
