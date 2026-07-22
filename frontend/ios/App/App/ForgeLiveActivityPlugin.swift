import ActivityKit
import Capacitor
import Foundation

@objc(ForgeLiveActivityPlugin)
public class ForgeLiveActivityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeLiveActivityPlugin"
    public let jsName = "ForgeLiveActivity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "end", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "currentActivityId", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["available": false, "reason": "Live Activities require iOS 16.1 or newer."])
            return
        }
        let enabled = ActivityAuthorizationInfo().areActivitiesEnabled
        call.resolve([
            "available": enabled,
            "reason": enabled ? NSNull() : "Live Activities are disabled in iPhone Settings."
        ])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.reject("Live Activities require iOS 16.1 or newer.")
            return
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            call.reject("Live Activities are disabled in iPhone Settings.")
            return
        }
        guard let attributesPayload = call.getObject("attributes"),
              let contentPayload = call.getObject("content") else {
            call.reject("attributes and content are required")
            return
        }

        do {
            let attributes = try buildAttributes(attributesPayload)
            let state = buildContentState(contentPayload)
            Task { @MainActor in
                for activity in Activity<ForgeRunAttributes>.activities {
                    await end(activity, state: state)
                }
                do {
                    let activity: Activity<ForgeRunAttributes>
                    if #available(iOS 16.2, *) {
                        activity = try Activity.request(
                            attributes: attributes,
                            content: ActivityContent(state: state, staleDate: staleDate(for: state)),
                            pushType: nil
                        )
                    } else {
                        activity = try Activity.request(attributes: attributes, contentState: state, pushType: nil)
                    }
                    call.resolve(["activityId": activity.id])
                } catch {
                    call.reject(error.localizedDescription)
                }
            }
        } catch {
            call.reject(error.localizedDescription)
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["updated": false])
            return
        }
        guard let contentPayload = call.getObject("content") else {
            call.reject("content is required")
            return
        }
        let state = buildContentState(contentPayload)
        Task { @MainActor in
            guard let activity = Activity<ForgeRunAttributes>.activities.first else {
                call.resolve(["updated": false])
                return
            }
            if #available(iOS 16.2, *) {
                await activity.update(ActivityContent(state: state, staleDate: staleDate(for: state)))
            } else {
                await activity.update(using: state)
            }
            call.resolve(["updated": true, "activityId": activity.id])
        }
    }

    @objc func end(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["ended": false])
            return
        }
        Task { @MainActor in
            let activities = Activity<ForgeRunAttributes>.activities
            for activity in activities {
                await end(activity, state: activity.contentState)
            }
            call.resolve(["ended": !activities.isEmpty])
        }
    }

    @objc func currentActivityId(_ call: CAPPluginCall) {
        guard #available(iOS 16.1, *) else {
            call.resolve(["activityId": NSNull()])
            return
        }
        if let activity = Activity<ForgeRunAttributes>.activities.first {
            call.resolve(["activityId": activity.id])
        } else {
            call.resolve(["activityId": NSNull()])
        }
    }

    @available(iOS 16.1, *)
    private func buildAttributes(_ payload: [String: Any]) throws -> ForgeRunAttributes {
        let runClientId = boundedString(payload["runClientId"], maximumLength: 64)
        guard !runClientId.isEmpty else { throw ForgeLiveActivityError.missingRunId }
        return ForgeRunAttributes(
            runClientId: runClientId,
            startedAtEpochMs: boundedDouble(payload["startedAtEpochMs"], minimum: 0, maximum: 4_102_444_800_000),
            unit: boundedString(payload["unit"], maximumLength: 2) == "km" ? "km" : "mi",
            title: boundedString(payload["title"], maximumLength: 40),
            targetLabel: boundedString(payload["targetLabel"], maximumLength: 24)
        )
    }

    @available(iOS 16.1, *)
    private func buildContentState(_ payload: [String: Any]) -> ForgeRunAttributes.ContentState {
        let gpsState = boundedString(payload["gpsState"], maximumLength: 12)
        let normalizedGpsState = ["acquiring", "tracking", "off"].contains(gpsState) ? gpsState : "acquiring"
        let color = boundedString(payload["hrZoneColorHex"], maximumLength: 7)
        let normalizedColor = color.range(of: "^#[0-9A-Fa-f]{6}$", options: .regularExpression) == nil ? "" : color.uppercased()
        return ForgeRunAttributes.ContentState(
            timerStartDateEpochMs: boundedDouble(payload["timerStartDateEpochMs"], minimum: 0, maximum: 4_102_444_800_000),
            distance: boundedDouble(payload["distance"], minimum: -1, maximum: 10_000),
            paceSecPerUnit: boundedInt(payload["paceSecPerUnit"], minimum: 0, maximum: 86_400),
            heartRate: boundedInt(payload["heartRate"], minimum: 0, maximum: 250),
            hrFresh: boolValue(payload["hrFresh"]),
            hrZoneKey: boundedString(payload["hrZoneKey"], maximumLength: 4),
            hrZoneColorHex: normalizedColor,
            gpsState: normalizedGpsState,
            gpsAccuracyMeters: boundedInt(payload["gpsAccuracyMeters"], minimum: -1, maximum: 10_000),
            staleAtEpochMs: boundedDouble(payload["staleAtEpochMs"], minimum: 0, maximum: 4_102_444_800_000)
        )
    }

    @available(iOS 16.1, *)
    private func staleDate(for state: ForgeRunAttributes.ContentState) -> Date? {
        guard state.staleAtEpochMs > 0 else { return nil }
        return Date(timeIntervalSince1970: state.staleAtEpochMs / 1000)
    }

    @available(iOS 16.1, *)
    private func end(_ activity: Activity<ForgeRunAttributes>, state: ForgeRunAttributes.ContentState) async {
        if #available(iOS 16.2, *) {
            await activity.end(
                ActivityContent(state: state, staleDate: nil),
                dismissalPolicy: .immediate
            )
        } else {
            await activity.end(using: state, dismissalPolicy: .immediate)
        }
    }

    private func boundedString(_ value: Any?, maximumLength: Int) -> String {
        let raw = (value as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(raw.prefix(maximumLength))
    }

    private func boundedDouble(_ value: Any?, minimum: Double, maximum: Double) -> Double {
        let parsed: Double
        if let number = value as? NSNumber { parsed = number.doubleValue }
        else if let string = value as? String, let number = Double(string) { parsed = number }
        else { parsed = minimum }
        guard parsed.isFinite else { return minimum }
        return min(maximum, max(minimum, parsed))
    }

    private func boundedInt(_ value: Any?, minimum: Int, maximum: Int) -> Int {
        return Int(boundedDouble(value, minimum: Double(minimum), maximum: Double(maximum)).rounded())
    }

    private func boolValue(_ value: Any?) -> Bool {
        if let bool = value as? Bool { return bool }
        if let number = value as? NSNumber { return number.boolValue }
        return false
    }
}

private enum ForgeLiveActivityError: LocalizedError {
    case missingRunId

    var errorDescription: String? {
        switch self {
        case .missingRunId:
            return "A run identifier is required to start the Live Activity."
        }
    }
}
