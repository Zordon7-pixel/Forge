import ActivityKit
import Foundation

@available(iOS 16.1, *)
struct ForgeRunAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let timerStartDateEpochMs: Double
        let elapsedSeconds: Int
        let isPaused: Bool
        let distance: Double
        let paceSecPerUnit: Int
        let heartRate: Int
        let hrFresh: Bool
        let hrZoneKey: String
        let hrZoneColorHex: String
        let gpsState: String
        let gpsAccuracyMeters: Int
        let staleAtEpochMs: Double
    }

    let runClientId: String
    let startedAtEpochMs: Double
    let unit: String
    let title: String
    let targetLabel: String
}
