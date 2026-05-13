import Capacitor
import Foundation
import HealthKit
import WorkoutKit

@objc(ForgeWatchWorkoutPlugin)
public class ForgeWatchWorkoutPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeWatchWorkoutPlugin"
    public let jsName = "ForgeWatchWorkout"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scheduleWorkout", returnType: CAPPluginReturnPromise)
    ]

    @objc func isAvailable(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) {
            call.resolve([
                "available": WorkoutScheduler.isSupported,
                "reason": WorkoutScheduler.isSupported ? NSNull() : "Apple Watch workout scheduling is not supported on this device."
            ])
            return
        }

        call.resolve([
            "available": false,
            "reason": "Apple Watch workout scheduling requires iOS 17 or newer."
        ])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        if #available(iOS 17.0, *) {
            Task {
                let state = await WorkoutScheduler.shared.requestAuthorization()
                DispatchQueue.main.async {
                    call.resolve([
                        "authorized": state == .authorized,
                        "state": self.authorizationStateName(state)
                    ])
                }
            }
            return
        }

        call.reject("Apple Watch workout scheduling requires iOS 17 or newer.")
    }

    @objc func scheduleWorkout(_ call: CAPPluginCall) {
        guard let workout = call.getObject("workout") else {
            call.reject("workout is required")
            return
        }

        if #available(iOS 17.0, *) {
            do {
                let plan = try buildWorkoutPlan(from: workout)
                let date = scheduleDateComponents(from: workout)
                Task {
                    await WorkoutScheduler.shared.schedule(plan, at: date)
                    DispatchQueue.main.async {
                        call.resolve([
                            "ok": true,
                            "scheduledAt": ISO8601DateFormatter().string(from: Calendar.current.date(from: date) ?? Date()),
                            "kind": workout["kind"] as? String ?? "workout"
                        ])
                    }
                }
            } catch {
                call.reject(error.localizedDescription)
            }
            return
        }

        call.reject("Apple Watch workout scheduling requires iOS 17 or newer.")
    }

    @available(iOS 17.0, *)
    private func buildWorkoutPlan(from payload: [String: Any]) throws -> WorkoutPlan {
        let kind = stringValue(payload["kind"]).lowercased()
        let activity = activityType(from: payload)
        let location = locationType(from: payload)

        if kind == "strength" {
            let workout = SingleGoalWorkout(activity: activity, location: location, goal: .open)
            guard SingleGoalWorkout.supportsActivity(activity) else {
                throw ForgeWatchWorkoutError.unsupportedActivity
            }
            return WorkoutPlan(.goal(workout))
        }

        if let pacer = pacerWorkout(from: payload, activity: activity, location: location) {
            return WorkoutPlan(.pacer(pacer))
        }

        let goal = workoutGoal(from: payload)
        guard SingleGoalWorkout.supportsGoal(goal, activity: activity, location: location) else {
            throw ForgeWatchWorkoutError.unsupportedGoal
        }

        let workout = SingleGoalWorkout(activity: activity, location: location, goal: goal)
        return WorkoutPlan(.goal(workout))
    }

    @available(iOS 17.0, *)
    private func pacerWorkout(from payload: [String: Any], activity: HKWorkoutActivityType, location: HKWorkoutSessionLocationType) -> PacerWorkout? {
        guard activity == .running else { return nil }
        guard let goal = payload["goal"] as? [String: Any] else { return nil }
        guard stringValue(goal["type"]) == "distance" else { return nil }

        let miles = doubleValue(goal["value"])
        let paceSecondsPerMile = doubleValue(payload["targetPaceSecondsPerMile"])
        guard miles > 0, paceSecondsPerMile > 0 else { return nil }

        let distance = Measurement(value: miles, unit: UnitLength.miles)
        let time = Measurement(value: miles * paceSecondsPerMile, unit: UnitDuration.seconds)
        guard PacerWorkout.supportsActivity(activity) else { return nil }
        return PacerWorkout(activity: activity, location: location, distance: distance, time: time)
    }

    @available(iOS 17.0, *)
    private func workoutGoal(from payload: [String: Any]) -> WorkoutGoal {
        guard let goal = payload["goal"] as? [String: Any] else { return .open }
        let type = stringValue(goal["type"])
        let value = doubleValue(goal["value"])

        if type == "distance", value > 0 {
            return .distance(value, .miles)
        }
        if type == "time", value > 0 {
            return .time(value, .minutes)
        }
        if type == "energy", value > 0 {
            return .energy(value, .kilocalories)
        }
        return .open
    }

    private func activityType(from payload: [String: Any]) -> HKWorkoutActivityType {
        let activity = stringValue(payload["activity"]).lowercased()
        switch activity {
        case "running", "run":
            return .running
        case "walking", "walk":
            return .walking
        case "cycling", "bike", "biking":
            return .cycling
        case "traditionalstrengthtraining":
            return .traditionalStrengthTraining
        case "functionalstrengthtraining", "strength":
            return .functionalStrengthTraining
        default:
            return .running
        }
    }

    private func locationType(from payload: [String: Any]) -> HKWorkoutSessionLocationType {
        let location = stringValue(payload["location"]).lowercased()
        if location == "indoor" { return .indoor }
        if location == "outdoor" { return .outdoor }
        return .unknown
    }

    private func scheduleDateComponents(from payload: [String: Any]) -> DateComponents {
        let scheduledAt = stringValue(payload["scheduledAt"])
        let date = ISO8601DateFormatter().date(from: scheduledAt) ?? Date()
        return Calendar.current.dateComponents([.calendar, .timeZone, .year, .month, .day, .hour, .minute], from: date)
    }

    @available(iOS 17.0, *)
    private func authorizationStateName(_ state: WorkoutScheduler.AuthorizationState) -> String {
        switch state {
        case .notDetermined:
            return "notDetermined"
        case .restricted:
            return "restricted"
        case .denied:
            return "denied"
        case .authorized:
            return "authorized"
        @unknown default:
            return "unknown"
        }
    }

    private func stringValue(_ value: Any?) -> String {
        if let value = value as? String { return value }
        return ""
    }

    private func doubleValue(_ value: Any?) -> Double {
        if let value = value as? Double { return value }
        if let value = value as? Int { return Double(value) }
        if let value = value as? String, let parsed = Double(value) { return parsed }
        return 0
    }
}

private enum ForgeWatchWorkoutError: LocalizedError {
    case unsupportedActivity
    case unsupportedGoal

    var errorDescription: String? {
        switch self {
        case .unsupportedActivity:
            return "This workout type is not supported by Apple Watch workout scheduling."
        case .unsupportedGoal:
            return "This workout goal is not supported by Apple Watch workout scheduling."
        }
    }
}
