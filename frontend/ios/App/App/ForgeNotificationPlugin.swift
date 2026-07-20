import Capacitor
import Foundation

enum ForgeNotificationNavigation {
    static let received = Notification.Name("forge.notification.navigation")
    private static let pendingKey = "forge.notification.pendingNavigation"

    static func store(_ userInfo: [AnyHashable: Any]) {
        let rawPath = String(describing: userInfo["path"] ?? "/history")
        let path = rawPath.hasPrefix("/") && rawPath.count <= 400 ? rawPath : "/history"
        var payload: [String: Any] = ["path": path]

        ["source", "sourceWorkoutId", "notificationId"].forEach { key in
            let value = String(describing: userInfo[key] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty && value.count <= 200 {
                payload[key] = value
            }
        }

        UserDefaults.standard.set(payload, forKey: pendingKey)
        NotificationCenter.default.post(name: received, object: nil)
    }

    static func consume() -> [String: Any]? {
        guard let payload = UserDefaults.standard.dictionary(forKey: pendingKey) else {
            return nil
        }
        UserDefaults.standard.removeObject(forKey: pendingKey)
        return payload
    }
}

@objc(ForgeNotificationPlugin)
public class ForgeNotificationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeNotificationPlugin"
    public let jsName = "ForgeNotification"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "consumePendingNavigation", returnType: CAPPluginReturnPromise)
    ]

    private var observer: NSObjectProtocol?

    public override func load() {
        super.load()
        observer = NotificationCenter.default.addObserver(
            forName: ForgeNotificationNavigation.received,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let payload = ForgeNotificationNavigation.consume() else { return }
            self?.notifyListeners("notificationNavigation", data: payload, retainUntilConsumed: true)
        }
    }

    deinit {
        if let observer = observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @objc func consumePendingNavigation(_ call: CAPPluginCall) {
        call.resolve(ForgeNotificationNavigation.consume() ?? [:])
    }
}
