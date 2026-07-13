import Capacitor

class AppViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        bridge?.registerPluginInstance(ForgeHealthPlugin())
        bridge?.registerPluginInstance(ForgeWatchWorkoutPlugin())
    }
}
