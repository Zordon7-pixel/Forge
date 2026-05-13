import Capacitor
import Foundation
import HealthKit

@objc(ForgeHealthPlugin)
public class ForgeHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ForgeHealthPlugin"
    public let jsName = "ForgeHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSummary", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()

    private var readTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()

        [
            HKQuantityTypeIdentifier.stepCount,
            HKQuantityTypeIdentifier.activeEnergyBurned,
            HKQuantityTypeIdentifier.distanceWalkingRunning,
            HKQuantityTypeIdentifier.heartRate
        ].forEach { identifier in
            if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                types.insert(type)
            }
        }

        types.insert(HKObjectType.workoutType())
        return types
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    @objc func requestAuthorization(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device.")
            return
        }

        healthStore.requestAuthorization(toShare: [], read: readTypes) { success, error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }
            call.resolve(["authorized": success])
        }
    }

    @objc func getSummary(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device.")
            return
        }

        let now = Date()
        let calendar = Calendar.current
        let todayStart = calendar.startOfDay(for: now)
        let weekStart = calendar.date(byAdding: .day, value: -6, to: todayStart) ?? todayStart

        let group = DispatchGroup()
        var stepsToday = 0.0
        var caloriesToday = 0.0
        var milesThisWeek = 0.0
        var workouts: [[String: Any]] = []
        var avgHeartRateLastRun: Double?

        group.enter()
        sumQuantity(.stepCount, unit: HKUnit.count(), startDate: todayStart, endDate: now) { value in
            stepsToday = value
            group.leave()
        }

        group.enter()
        sumQuantity(.activeEnergyBurned, unit: HKUnit.kilocalorie(), startDate: todayStart, endDate: now) { value in
            caloriesToday = value
            group.leave()
        }

        group.enter()
        sumQuantity(.distanceWalkingRunning, unit: HKUnit.mile(), startDate: weekStart, endDate: now) { value in
            milesThisWeek = value
            group.leave()
        }

        group.enter()
        fetchWorkouts(startDate: weekStart, endDate: now) { rows, latestRun in
            workouts = rows
            guard let run = latestRun else {
                group.leave()
                return
            }

            self.averageHeartRate(startDate: run.startDate, endDate: run.endDate) { value in
                avgHeartRateLastRun = value
                group.leave()
            }
        }

        group.notify(queue: .main) {
            var payload: [String: Any] = [
                "stepsToday": Int(stepsToday.rounded()),
                "caloriesBurnedToday": Int(caloriesToday.rounded()),
                "totalMilesThisWeek": round(milesThisWeek * 100) / 100,
                "workouts": workouts
            ]
            payload["avgHeartRateFromLastRun"] = avgHeartRateLastRun.map { Int($0.rounded()) } ?? NSNull()
            call.resolve(payload)
        }
    }

    private func sumQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, startDate: Date, endDate: Date, completion: @escaping (Double) -> Void) {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else {
            completion(0)
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .cumulativeSum) { _, statistics, _ in
            completion(statistics?.sumQuantity()?.doubleValue(for: unit) ?? 0)
        }
        healthStore.execute(query)
    }

    private func fetchWorkouts(startDate: Date, endDate: Date, completion: @escaping ([[String: Any]], HKWorkout?) -> Void) {
        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: false)
        let query = HKSampleQuery(sampleType: HKObjectType.workoutType(), predicate: predicate, limit: 50, sortDescriptors: [sort]) { _, samples, _ in
            let workouts = (samples as? [HKWorkout]) ?? []
            let rows = workouts.map { self.serializeWorkout($0) }
            let latestRun = workouts.first { $0.workoutActivityType == .running }
            completion(rows, latestRun)
        }
        healthStore.execute(query)
    }

    private func averageHeartRate(startDate: Date, endDate: Date, completion: @escaping (Double?) -> Void) {
        guard let type = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            completion(nil)
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage) { _, statistics, _ in
            let unit = HKUnit.count().unitDivided(by: HKUnit.minute())
            completion(statistics?.averageQuantity()?.doubleValue(for: unit))
        }
        healthStore.execute(query)
    }

    private func serializeWorkout(_ workout: HKWorkout) -> [String: Any] {
        let distanceMiles = workout.totalDistance?.doubleValue(for: HKUnit.mile()) ?? 0
        let calories = workout.totalEnergyBurned?.doubleValue(for: HKUnit.kilocalorie()) ?? 0

        return [
            "date": isoDate(workout.startDate),
            "startDate": isoDateTime(workout.startDate),
            "endDate": isoDateTime(workout.endDate),
            "type": workoutTypeName(workout.workoutActivityType),
            "distanceMiles": round(distanceMiles * 1000) / 1000,
            "durationSeconds": Int(workout.duration.rounded()),
            "calories": Int(calories.rounded()),
            "source": "apple_health"
        ]
    }

    private func workoutTypeName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running:
            return "run"
        case .walking:
            return "walk"
        case .traditionalStrengthTraining, .functionalStrengthTraining:
            return "strength"
        case .highIntensityIntervalTraining:
            return "hiit"
        case .cycling:
            return "cycling"
        case .swimming:
            return "swimming"
        default:
            return "workout"
        }
    }

    private func isoDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .iso8601)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone.current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    private func isoDateTime(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }
}
