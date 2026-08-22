import Capacitor
import CoreMotion
import Foundation
import UIKit

@objc(ForgeMotionPlugin)
public class ForgeMotionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeMotionPlugin"
    public let jsName = "ForgeMotion"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "queryHistory", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    private let activityManager = CMMotionActivityManager()
    private let pedometer = CMPedometer()
    private let maximumHistoryInterval: TimeInterval = 7 * 24 * 60 * 60

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(statusPayload())
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard CMMotionActivityManager.isActivityAvailable(),
              CMPedometer.isStepCountingAvailable(),
              CMPedometer.isDistanceAvailable() else {
            call.reject("Motion & Fitness history is unavailable on this iPhone.", "UNAVAILABLE")
            return
        }

        let currentAuthorization = combinedAuthorization()
        if currentAuthorization == "authorized" {
            call.resolve(statusPayload())
            return
        }
        if currentAuthorization == "denied" || currentAuthorization == "restricted" {
            call.reject(
                "Motion & Fitness access is \(currentAuthorization). Allow Forged Hybrid in iPhone Settings to recover missed starts.",
                currentAuthorization.uppercased()
            )
            return
        }

        let endDate = Date()
        let startDate = endDate.addingTimeInterval(-60)
        let group = DispatchGroup()
        var firstError: Error?

        group.enter()
        activityManager.queryActivityStarting(from: startDate, to: endDate, to: .main) { _, error in
            if let error = error, firstError == nil { firstError = error }
            group.leave()
        }

        group.enter()
        pedometer.queryPedometerData(from: startDate, to: endDate) { _, error in
            DispatchQueue.main.async {
                if let error = error, firstError == nil { firstError = error }
                group.leave()
            }
        }

        group.notify(queue: .main) {
            let authorization = self.combinedAuthorization()
            if authorization == "denied" || authorization == "restricted" {
                call.reject(
                    "Motion & Fitness access is \(authorization). Allow Forged Hybrid in iPhone Settings to recover missed starts.",
                    authorization.uppercased()
                )
                return
            }
            if let firstError = firstError {
                call.reject("Motion & Fitness permission could not be completed.", "NATIVE_ERROR", firstError)
                return
            }
            call.resolve(self.statusPayload())
        }
    }

    @objc func queryHistory(_ call: CAPPluginCall) {
        guard CMMotionActivityManager.isActivityAvailable(),
              CMPedometer.isStepCountingAvailable(),
              CMPedometer.isDistanceAvailable() else {
            call.reject("Motion & Fitness history is unavailable on this iPhone.", "UNAVAILABLE")
            return
        }
        let authorization = combinedAuthorization()
        guard authorization == "authorized" else {
            call.reject(
                "Motion & Fitness access is \(authorization).",
                authorization == "restricted" ? "RESTRICTED" : "DENIED"
            )
            return
        }
        guard let startText = call.getString("startDate"),
              let endText = call.getString("endDate"),
              let startDate = parseISODate(startText),
              let endDate = parseISODate(endText),
              startDate < endDate else {
            call.reject("Motion history dates must be valid ISO timestamps with start before end.", "MALFORMED_DATES")
            return
        }

        let now = Date()
        let interval = endDate.timeIntervalSince(startDate)
        guard interval <= maximumHistoryInterval,
              endDate <= now.addingTimeInterval(60),
              startDate >= now.addingTimeInterval(-maximumHistoryInterval - 60) else {
            call.reject("Motion history must be a recent interval no longer than seven days.", "MALFORMED_DATES")
            return
        }

        activityManager.queryActivityStarting(from: startDate, to: endDate, to: .main) { activities, error in
            if let error = error {
                call.reject("Motion activity history could not be read.", "NATIVE_ERROR", error)
                return
            }
            guard let activities = activities, !activities.isEmpty else {
                call.reject("No Motion & Fitness history was available for that interval.", "EMPTY_HISTORY")
                return
            }

            let segments = self.normalizedSegments(activities, queryEnd: endDate)
            guard !segments.isEmpty else {
                call.reject("No usable Motion & Fitness history was available for that interval.", "EMPTY_HISTORY")
                return
            }
            self.queryPedometerSummaries(for: segments, call: call)
        }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let settingsURL = URL(string: UIApplication.openSettingsURLString),
                  UIApplication.shared.canOpenURL(settingsURL) else {
                call.reject("iPhone Settings is unavailable.", "UNAVAILABLE")
                return
            }
            UIApplication.shared.open(settingsURL, options: [:]) { opened in
                if opened { call.resolve(["opened": true]) }
                else { call.reject("iPhone Settings could not be opened.", "NATIVE_ERROR") }
            }
        }
    }

    private func queryPedometerSummaries(for segments: [[String: Any]], call: CAPPluginCall) {
        let runningSegments = segments.filter { segment in
            segment["running"] as? Bool == true && segment["automotive"] as? Bool != true
        }
        guard !runningSegments.isEmpty else {
            call.resolve(["activitySegments": publicSegments(segments), "pedometerSummaries": []])
            return
        }

        let group = DispatchGroup()
        var summaries = [[String: Any]]()
        var firstError: Error?

        for segment in runningSegments {
            guard let startDate = segment["nativeStartDate"] as? Date,
                  let endDate = segment["nativeEndDate"] as? Date else { continue }
            group.enter()
            pedometer.queryPedometerData(from: startDate, to: endDate) { data, error in
                DispatchQueue.main.async {
                    if let error = error {
                        if firstError == nil { firstError = error }
                    } else if let data = data {
                        summaries.append(self.pedometerPayload(data, requestedStart: startDate, requestedEnd: endDate))
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            if let firstError = firstError {
                call.reject("Pedometer history could not be read.", "NATIVE_ERROR", firstError)
                return
            }
            call.resolve([
                "activitySegments": self.publicSegments(segments),
                "pedometerSummaries": summaries.sorted {
                    String(describing: $0["startDate"] ?? "") < String(describing: $1["startDate"] ?? "")
                }
            ])
        }
    }

    private func normalizedSegments(_ activities: [CMMotionActivity], queryEnd: Date) -> [[String: Any]] {
        let ordered = activities.sorted { $0.startDate < $1.startDate }
        let rawSegments = ordered.enumerated().compactMap { index, activity -> [String: Any]? in
            let startDate = activity.startDate
            let nextStart = index + 1 < ordered.count ? ordered[index + 1].startDate : queryEnd
            let endDate = min(nextStart, queryEnd)
            guard endDate > startDate else { return nil }
            return [
                "startDate": isoString(startDate),
                "endDate": isoString(endDate),
                "activity": activityName(activity),
                "confidence": confidenceName(activity.confidence),
                "running": activity.running,
                "walking": activity.walking,
                "automotive": activity.automotive,
                "cycling": activity.cycling,
                "stationary": activity.stationary,
                "unknown": activity.unknown,
                "nativeStartDate": startDate,
                "nativeEndDate": endDate
            ]
        }
        return rawSegments.reduce(into: [[String: Any]]()) { merged, segment in
            guard var previous = merged.last,
                  sameActivity(previous, segment),
                  let previousEnd = previous["nativeEndDate"] as? Date,
                  let segmentStart = segment["nativeStartDate"] as? Date,
                  abs(previousEnd.timeIntervalSince(segmentStart)) <= 1 else {
                merged.append(segment)
                return
            }
            previous["endDate"] = segment["endDate"]
            previous["nativeEndDate"] = segment["nativeEndDate"]
            if String(describing: previous["confidence"] ?? "") != String(describing: segment["confidence"] ?? "") {
                previous["confidence"] = "mixed"
            }
            merged[merged.count - 1] = previous
        }
    }

    private func sameActivity(_ left: [String: Any], _ right: [String: Any]) -> Bool {
        let booleanKeys = ["running", "walking", "automotive", "cycling", "stationary", "unknown"]
        return String(describing: left["activity"] ?? "") == String(describing: right["activity"] ?? "")
            && booleanKeys.allSatisfy { (left[$0] as? Bool) == (right[$0] as? Bool) }
    }

    private func publicSegments(_ segments: [[String: Any]]) -> [[String: Any]] {
        segments.map { segment in
            segment.filter { key, _ in key != "nativeStartDate" && key != "nativeEndDate" }
        }
    }

    private func pedometerPayload(_ data: CMPedometerData, requestedStart: Date, requestedEnd: Date) -> [String: Any] {
        var payload: [String: Any] = [
            "startDate": isoString(requestedStart),
            "endDate": isoString(requestedEnd),
            "steps": data.numberOfSteps.intValue
        ]
        if let distance = finitePositive(data.distance?.doubleValue) {
            payload["distanceMeters"] = distance
        }
        if let pace = finitePositive(data.averageActivePace?.doubleValue) {
            payload["averageActivePaceSecondsPerMeter"] = pace
        }
        if let currentPace = finitePositive(data.currentPace?.doubleValue) {
            payload["currentPaceSecondsPerMeter"] = currentPace
        }
        if let cadence = finitePositive(data.currentCadence?.doubleValue) {
            payload["cadenceStepsPerSecond"] = cadence
        }
        return payload
    }

    private func statusPayload() -> [String: Any] {
        let activityAvailable = CMMotionActivityManager.isActivityAvailable()
        let pedometerAvailable = CMPedometer.isStepCountingAvailable()
        let distanceAvailable = CMPedometer.isDistanceAvailable()
        return [
            "available": activityAvailable && pedometerAvailable && distanceAvailable,
            "activityAvailable": activityAvailable,
            "pedometerAvailable": pedometerAvailable,
            "distanceAvailable": distanceAvailable,
            "authorization": combinedAuthorization(),
            "activityAuthorization": authorizationName(CMMotionActivityManager.authorizationStatus()),
            "pedometerAuthorization": authorizationName(CMPedometer.authorizationStatus())
        ]
    }

    private func combinedAuthorization() -> String {
        let states = [
            authorizationName(CMMotionActivityManager.authorizationStatus()),
            authorizationName(CMPedometer.authorizationStatus())
        ]
        if states.contains("denied") { return "denied" }
        if states.contains("restricted") { return "restricted" }
        if states.allSatisfy({ $0 == "authorized" }) { return "authorized" }
        return "not_determined"
    }

    private func authorizationName(_ status: CMAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not_determined"
        @unknown default: return "restricted"
        }
    }

    private func activityName(_ activity: CMMotionActivity) -> String {
        if activity.automotive { return "automotive" }
        if activity.running { return "running" }
        if activity.walking { return "walking" }
        if activity.cycling { return "cycling" }
        if activity.stationary { return "stationary" }
        return "unknown"
    }

    private func confidenceName(_ confidence: CMMotionActivityConfidence) -> String {
        switch confidence {
        case .high: return "high"
        case .medium: return "medium"
        case .low: return "low"
        @unknown default: return "unknown"
        }
    }

    private func parseISODate(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let standard = ISO8601DateFormatter()
        standard.formatOptions = [.withInternetDateTime]
        return standard.date(from: value)
    }

    private func isoString(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    private func finitePositive(_ value: Double?) -> Double? {
        guard let value = value, value.isFinite, value > 0 else { return nil }
        return value
    }
}
