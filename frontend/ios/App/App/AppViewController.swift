import Capacitor

class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(ForgeHealthPlugin())
        bridge?.registerPluginInstance(ForgeWatchWorkoutPlugin())
        bridge?.registerPluginInstance(ForgeContactsPlugin())
        bridge?.registerPluginInstance(ForgeNotificationPlugin())
        bridge?.registerPluginInstance(ForgePhotosPlugin())
    }
}
