import Capacitor
import CoreLocation
import UIKit

class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(ForgeHealthPlugin())
        bridge?.registerPluginInstance(ForgeWatchWorkoutPlugin())
        bridge?.registerPluginInstance(ForgeContactsPlugin())
        bridge?.registerPluginInstance(ForgeNotificationPlugin())
        bridge?.registerPluginInstance(ForgePhotosPlugin())
        bridge?.registerPluginInstance(ForgeLiveActivityPlugin())
        bridge?.registerPluginInstance(ForgeMotionPlugin())
        bridge?.registerPluginInstance(ForgeRunReadinessPlugin())
    }
}

// Kept in this already-compiled source so no project/generated registration churn is needed.
@objc(ForgeRunReadinessPlugin)
public class ForgeRunReadinessPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeRunReadinessPlugin"
    public let jsName = "ForgeRunReadiness"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimExplainer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "claimFirstRun", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    @objc func getStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let manager = CLLocationManager()
            let refresh: String
            switch UIApplication.shared.backgroundRefreshStatus {
            case .available: refresh = "available"
            case .denied: refresh = "denied"
            case .restricted: refresh = "restricted"
            @unknown default: refresh = "unknown"
            }
            let location: String
            switch manager.authorizationStatus {
            case .authorizedAlways: location = "always"
            case .authorizedWhenInUse: location = "while_using"
            case .denied: location = "denied"
            case .restricted: location = "restricted"
            case .notDetermined: location = "not_determined"
            @unknown default: location = "unknown"
            }
            let precise: String
            switch manager.accuracyAuthorization {
            case .fullAccuracy: precise = "precise"
            case .reducedAccuracy: precise = "reduced"
            @unknown default: precise = "unknown"
            }
            call.resolve(["backgroundRefreshStatus": refresh,
                          "locationAuthorization": location, "accuracyAuthorization": precise])
        }
    }

    // Atomic on the main queue. Stored before presentation/navigation, never reset by settings.
    private func claim(_ key: String, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let first = !UserDefaults.standard.bool(forKey: key)
            if first { UserDefaults.standard.set(true, forKey: key) }
            call.resolve(["first": first])
        }
    }

    @objc func claimExplainer(_ call: CAPPluginCall) {
        claim("forge.runReadiness.explainerShown.v1", call)
    }

    @objc func claimFirstRun(_ call: CAPPluginCall) {
        claim("forge.runReadiness.firstRunStarted.v1", call)
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(url) else {
                call.resolve(["opened": false])
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                call.resolve(["opened": opened])
            }
        }
    }
}
