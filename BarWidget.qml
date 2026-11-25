import QtQuick
import Quickshell
import Quickshell.Hyprland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "Model.js" as Model

// Overdue's bar icon (ST-1..ST-5). Built once per monitor, so it holds no
// timers or data of its own (NF-2): every number it shows is bound to the
// service. Left click opens the task panel, right click the quick-add line.
//
// Bar.findPanelWidget routes summon/hide through open/close/opened on this
// root, so the panel lifecycle is forwarded to TaskPanel.qml, as omarchy.clock
// does.
BarWidget {
  id: root

  readonly property string pluginId: root.moduleName || Model.PLUGIN_ID

  // ------------------------------------------------------------- service

  property var service: null
  property int serviceAttempts: 0

  function findService() {
    var api = root.bar ? root.bar.shell : null
    var found = api && typeof api.serviceFor === "function" ? api.serviceFor(root.pluginId) : null
    if (found !== root.service) {
      if (root.service && typeof root.service.unregisterPanelHost === "function") root.service.unregisterPanelHost(root)
      root.service = found
      if (found) {
        found.registerPanelHost(root)
        root.pushSettings()
      }
    }
    // The service may finish loading after the bar builds this widget. Look
    // again briefly, then give up: under a replacement bar there is no
    // service facade at all (see README).
    if (!found && root.serviceAttempts < 20) {
      root.serviceAttempts += 1
      serviceRetry.restart()
    }
  }

  Timer {
    id: serviceRetry
    interval: 500
    repeat: false
    onTriggered: root.findService()
  }

  onBarChanged: findService()
  Component.onCompleted: findService()
  Component.onDestruction: if (root.service) root.service.unregisterPanelHost(root)

  // The widget's manifest schema is Overdue's settings UI; the service keeps
  // them (and uses them even when the widget is gone).
  onSettingsChanged: pushSettings()
  function pushSettings() {
    if (root.service && root.settings) root.service.applySettings(root.settings)
  }

  // --------------------------------------------------------------- state

  readonly property var summary: service ? service.summary : ({ state: "idle", overdue: 0, today: 0 })
  readonly property bool showCount: setting("showCount", true) !== false
  readonly property bool snoozed: service ? service.snoozed : false
  readonly property int count: summary.state === "overdue" ? summary.overdue : summary.state === "today" ? summary.today : 0

  function onFocusedMonitor() {
    var win = root.QsWindow.window
    var monitor = Hyprland.focusedMonitor
    return !!(win && win.screen && monitor && win.screen.name === monitor.name)
  }

  // ----------------------------------------------------- panel contract

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }
  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function closeForPopoutSwitch() { if (panelLoader.item) panelLoader.item.closeForPopoutSwitch() }

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    target.bar = root.bar
    target.settings = root.settings
    target.anchorItem = button
    target.hostWidget = root
    target.service = root.service
  }

  onServiceChanged: injectPanel()

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("TaskPanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: Model.stateGlyph(root.summary.state, root.snoozed)
    labelText: root.showCount && root.count > 0 && !root.vertical ? Commons.I18n.formatNumber(root.count) : ""
    // Overdue paints in the bar's urgent colour (ST-2).
    active: root.summary.state === "overdue" && !root.snoozed
    dimmed: !root.service
    // The icon slot is fixed-width; a count beside it widens the slot.
    fixedWidth: root.vertical ? -1 : slotSize + (labelText !== "" ? countMetrics.advanceWidth + Style.space(4) : 0)

    onPressed: function(mouseButton) {
      if (mouseButton === Qt.RightButton) {
        if (root.service) root.service.quickAdd()
      } else if (mouseButton === Qt.LeftButton) {
        // Relative times in the panel are measured from now, not the last wake.
        if (root.service) root.service.schedule()
        root.togglePanel()
      }
    }
  }

  TextMetrics {
    id: countMetrics
    font.family: button.fontFamily
    font.pixelSize: button.fontSize
    text: button.labelText
  }
}
