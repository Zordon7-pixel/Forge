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
        CAPPluginMethod(name: "getSummary", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWorkoutHistory", returnType: CAPPluginReturnPromise)
    ]

    private let healthStore = HKHealthStore()
    private let workoutAnchorKey = "forge.healthkit.workoutHistoryAnchor"

    private var readTypes: Set<HKObjectType> {
        var types = Set<HKObjectType>()

        [
            HKQuantityTypeIdentifier.stepCount,
            HKQuantityTypeIdentifier.activeEnergyBurned,
            HKQuantityTypeIdentifier.distanceWalkingRunning,
            HKQuantityTypeIdentifier.heartRate,
            HKQuantityTypeIdentifier.restingHeartRate,
            HKQuantityTypeIdentifier.heartRateVariabilitySDNN,
            HKQuantityTypeIdentifier.walkingHeartRateAverage,
            HKQuantityTypeIdentifier.vo2Max,
            HKQuantityTypeIdentifier.respiratoryRate,
            HKQuantityTypeIdentifier.appleExerciseTime
        ].forEach { identifier in
            if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                types.insert(type)
            }
        }

        if let sleepType = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) {
            types.insert(sleepType)
        }
        if #available(iOS 16.0, *) {
            [
                HKQuantityTypeIdentifier.heartRateRecoveryOneMinute,
                HKQuantityTypeIdentifier.runningPower,
                HKQuantityTypeIdentifier.runningSpeed,
                HKQuantityTypeIdentifier.runningStrideLength,
                HKQuantityTypeIdentifier.runningVerticalOscillation,
                HKQuantityTypeIdentifier.runningGroundContactTime
            ].forEach { identifier in
                if let type = HKObjectType.quantityType(forIdentifier: identifier) {
                    types.insert(type)
                }
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
        let monthStart = calendar.date(byAdding: .day, value: -28, to: todayStart) ?? weekStart

        let group = DispatchGroup()
        var stepsToday = 0.0
        var caloriesToday = 0.0
        var milesThisWeek = 0.0
        var workouts: [[String: Any]] = []
        var avgHeartRateLastRun: Double?
        var restingHeartRate: Double?
        var restingHeartRateBaseline: Double?
        var restingHeartRateRecordedAt: Date?
        var hrv: Double?
        var hrvBaseline: Double?
        var hrvRecordedAt: Date?
        var sleepHoursLastNight: Double?
        var sleepHours7dBaseline: Double?
        var sleepCoreHours: Double?
        var sleepDeepHours: Double?
        var sleepREMHours: Double?
        var sleepAwakeHours: Double?
        var sleepEndAt: Date?
        var activeMinutesThisWeek = 0.0
        var exerciseMinutesThisWeek = 0.0
        var lastWorkoutType: String?
        var lastWorkoutDurationSeconds: Int?
        var lastWorkoutCalories: Int?
        var vo2Max: Double?
        var vo2MaxRecordedAt: Date?
        var walkingHeartRateAverage: Double?
        var walkingHeartRateRecordedAt: Date?
        var heartRateRecoveryOneMinute: Double?
        var heartRateRecoveryRecordedAt: Date?
        var respiratoryRate: Double?
        var respiratoryRateRecordedAt: Date?
        var runningDynamics = RunningDynamicsSummary()

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
            activeMinutesThisWeek = rows.reduce(0.0) { sum, row in
                sum + (row["durationSeconds"] as? Double ?? Double(row["durationSeconds"] as? Int ?? 0)) / 60.0
            }
            if let latest = rows.first {
                lastWorkoutType = latest["type"] as? String
                lastWorkoutDurationSeconds = latest["durationSeconds"] as? Int
                lastWorkoutCalories = latest["calories"] as? Int
            }
            guard let run = latestRun else {
                group.leave()
                return
            }

            let runGroup = DispatchGroup()
            runGroup.enter()
            self.averageHeartRate(startDate: run.startDate, endDate: run.endDate) { value in
                avgHeartRateLastRun = value
                runGroup.leave()
            }
            runGroup.enter()
            self.fetchRunningDynamics(workout: run) { value in
                runningDynamics = value
                runGroup.leave()
            }
            runGroup.notify(queue: .global(qos: .userInitiated)) {
                group.leave()
            }
        }

        group.enter()
        fetchQuantityTrend(.restingHeartRate, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), startDate: monthStart, endDate: now, baselineDays: 21) { trend in
            restingHeartRate = trend.current
            restingHeartRateBaseline = trend.baseline
            restingHeartRateRecordedAt = trend.recordedAt
            group.leave()
        }

        group.enter()
        fetchQuantityTrend(.heartRateVariabilitySDNN, unit: HKUnit.secondUnit(with: .milli), startDate: monthStart, endDate: now, baselineDays: 21) { trend in
            hrv = trend.current
            hrvBaseline = trend.baseline
            hrvRecordedAt = trend.recordedAt
            group.leave()
        }

        group.enter()
        fetchSleepSummary(startDate: calendar.date(byAdding: .day, value: -9, to: todayStart) ?? weekStart, endDate: now) { summary in
            sleepHoursLastNight = summary.endDate == nil ? nil : summary.totalHours
            sleepHours7dBaseline = summary.baselineHours
            sleepCoreHours = summary.coreHours
            sleepDeepHours = summary.deepHours
            sleepREMHours = summary.remHours
            sleepAwakeHours = summary.awakeHours
            sleepEndAt = summary.endDate
            group.leave()
        }

        group.enter()
        sumQuantity(.appleExerciseTime, unit: HKUnit.minute(), startDate: weekStart, endDate: now) { value in
            exerciseMinutesThisWeek = value
            group.leave()
        }

        group.enter()
        fetchQuantityTrend(.vo2Max, unit: HKUnit(from: "ml/kg*min"), startDate: calendar.date(byAdding: .day, value: -180, to: now) ?? monthStart, endDate: now, baselineDays: 0) { trend in
            vo2Max = trend.current
            vo2MaxRecordedAt = trend.recordedAt
            group.leave()
        }

        group.enter()
        fetchQuantityTrend(.walkingHeartRateAverage, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), startDate: monthStart, endDate: now, baselineDays: 0) { trend in
            walkingHeartRateAverage = trend.current
            walkingHeartRateRecordedAt = trend.recordedAt
            group.leave()
        }

        group.enter()
        fetchQuantityTrend(.respiratoryRate, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), startDate: weekStart, endDate: now, baselineDays: 0) { trend in
            respiratoryRate = trend.current
            respiratoryRateRecordedAt = trend.recordedAt
            group.leave()
        }

        if #available(iOS 16.0, *) {
            group.enter()
            fetchQuantityTrend(.heartRateRecoveryOneMinute, unit: HKUnit.count().unitDivided(by: HKUnit.minute()), startDate: calendar.date(byAdding: .day, value: -90, to: now) ?? monthStart, endDate: now, baselineDays: 0) { trend in
                heartRateRecoveryOneMinute = trend.current
                heartRateRecoveryRecordedAt = trend.recordedAt
                group.leave()
            }
        }

        group.notify(queue: .main) {
            var payload: [String: Any] = [
                "metricsSchemaVersion": 2,
                "stepsToday": Int(stepsToday.rounded()),
                "caloriesBurnedToday": Int(caloriesToday.rounded()),
                "totalMilesThisWeek": round(milesThisWeek * 100) / 100,
                "activeMinutesThisWeek": Int(activeMinutesThisWeek.rounded()),
                "exerciseMinutesThisWeek": Int(exerciseMinutesThisWeek.rounded()),
                "activitySummaryRecordedAt": self.isoDateTime(now),
                "workoutCountThisWeek": workouts.count,
                "workouts": workouts
            ]
            payload["avgHeartRateFromLastRun"] = avgHeartRateLastRun.map { Int($0.rounded()) } ?? NSNull()
            payload["restingHeartRate"] = restingHeartRate.map { Int($0.rounded()) } ?? NSNull()
            payload["restingHeartRateBaseline"] = restingHeartRateBaseline.map { Int($0.rounded()) } ?? NSNull()
            payload["restingHeartRateRecordedAt"] = restingHeartRateRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["heartRateVariabilityMs"] = hrv.map { Int($0.rounded()) } ?? NSNull()
            payload["heartRateVariabilityBaselineMs"] = hrvBaseline.map { Int($0.rounded()) } ?? NSNull()
            payload["heartRateVariabilityRecordedAt"] = hrvRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["sleepHoursLastNight"] = sleepHoursLastNight.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepHours7dBaseline"] = sleepHours7dBaseline.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepCoreHours"] = sleepCoreHours.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepDeepHours"] = sleepDeepHours.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepREMHours"] = sleepREMHours.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepAwakeHours"] = sleepAwakeHours.map { round($0 * 10) / 10 } ?? NSNull()
            payload["sleepEndAt"] = sleepEndAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["vo2Max"] = vo2Max.map { round($0 * 10) / 10 } ?? NSNull()
            payload["vo2MaxRecordedAt"] = vo2MaxRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["walkingHeartRateAverage"] = walkingHeartRateAverage.map { Int($0.rounded()) } ?? NSNull()
            payload["walkingHeartRateRecordedAt"] = walkingHeartRateRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["heartRateRecoveryOneMinute"] = heartRateRecoveryOneMinute.map { Int($0.rounded()) } ?? NSNull()
            payload["heartRateRecoveryRecordedAt"] = heartRateRecoveryRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["respiratoryRate"] = respiratoryRate.map { round($0 * 10) / 10 } ?? NSNull()
            payload["respiratoryRateRecordedAt"] = respiratoryRateRecordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["runningPowerWatts"] = runningDynamics.powerWatts.map { Int($0.rounded()) } ?? NSNull()
            payload["runningSpeedMps"] = runningDynamics.speedMps.map { round($0 * 100) / 100 } ?? NSNull()
            payload["runningStrideLengthM"] = runningDynamics.strideLengthM.map { round($0 * 100) / 100 } ?? NSNull()
            payload["runningVerticalOscillationCm"] = runningDynamics.verticalOscillationCm.map { round($0 * 10) / 10 } ?? NSNull()
            payload["runningGroundContactTimeMs"] = runningDynamics.groundContactTimeMs.map { Int($0.rounded()) } ?? NSNull()
            payload["runningDynamicsRecordedAt"] = runningDynamics.recordedAt.map { self.isoDateTime($0) } ?? NSNull()
            payload["lastWorkoutType"] = lastWorkoutType ?? NSNull()
            payload["lastWorkoutDurationSeconds"] = lastWorkoutDurationSeconds ?? NSNull()
            payload["lastWorkoutCalories"] = lastWorkoutCalories ?? NSNull()
            call.resolve(payload)
        }
    }

    @objc func getWorkoutHistory(_ call: CAPPluginCall) {
        guard HKHealthStore.isHealthDataAvailable() else {
            call.reject("Apple Health is not available on this device.")
            return
        }

        let now = Date()
        let defaultStart = Calendar.current.date(byAdding: .month, value: -18, to: now) ?? now
        let requestedStart = call.getString("startDate").flatMap { parseDate($0) }
        let startDate = requestedStart ?? defaultStart
        let endDate = call.getString("endDate").flatMap { parseDate($0) } ?? now
        let suppliedMaxHR = call.getDouble("maxHR")
        let forceFullSync = call.getBool("forceFullSync") ?? false

        fetchAnchoredWorkoutHistory(startDate: startDate, endDate: endDate, forceFullSync: forceFullSync) { workouts, newAnchor, usedAnchor, error in
            if let error = error {
                call.reject(error.localizedDescription)
                return
            }

            self.enrichWorkoutsWithHeartRate(workouts, suppliedMaxHR: suppliedMaxHR) { rows, observedMaxHR in
                if let anchor = newAnchor {
                    self.saveWorkoutAnchor(anchor)
                }
                DispatchQueue.main.async {
                    call.resolve([
                        "workouts": rows,
                        "observedMaxHR": observedMaxHR.map { Int($0.rounded()) } ?? NSNull(),
                        "incremental": usedAnchor,
                        "startDate": self.isoDateTime(startDate),
                        "endDate": self.isoDateTime(endDate)
                    ])
                }
            }
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

    private func averageQuantity(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, startDate: Date, endDate: Date, completion: @escaping (Double?) -> Void) {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else {
            completion(nil)
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let query = HKStatisticsQuery(quantityType: type, quantitySamplePredicate: predicate, options: .discreteAverage) { _, statistics, _ in
            completion(statistics?.averageQuantity()?.doubleValue(for: unit))
        }
        healthStore.execute(query)
    }

    private struct QuantityTrend {
        let current: Double?
        let baseline: Double?
        let recordedAt: Date?
    }

    private func fetchQuantityTrend(_ identifier: HKQuantityTypeIdentifier, unit: HKUnit, startDate: Date, endDate: Date, baselineDays: Int, completion: @escaping (QuantityTrend) -> Void) {
        guard let type = HKQuantityType.quantityType(forIdentifier: identifier) else {
            completion(QuantityTrend(current: nil, baseline: nil, recordedAt: nil))
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierEndDate, ascending: true)
        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error {
                NSLog("ForgeHealthPlugin %@ query failed: %@", identifier.rawValue, error.localizedDescription)
                completion(QuantityTrend(current: nil, baseline: nil, recordedAt: nil))
                return
            }

            let quantitySamples = samples as? [HKQuantitySample] ?? []
            let calendar = Calendar.current
            var dailyValues: [Date: [Double]] = [:]
            for sample in quantitySamples {
                let value = sample.quantity.doubleValue(for: unit)
                guard value.isFinite else { continue }
                dailyValues[calendar.startOfDay(for: sample.endDate), default: []].append(value)
            }
            let dailyAverages = dailyValues.keys.sorted().compactMap { day -> Double? in
                guard let values = dailyValues[day], !values.isEmpty else { return nil }
                return values.reduce(0, +) / Double(values.count)
            }
            let baselineValues = baselineDays > 0 ? Array(dailyAverages.dropLast().suffix(baselineDays)) : []
            let baseline = baselineValues.count >= 3 ? baselineValues.reduce(0, +) / Double(baselineValues.count) : nil
            completion(QuantityTrend(current: dailyAverages.last, baseline: baseline, recordedAt: quantitySamples.last?.endDate))
        }
        healthStore.execute(query)
    }

    private struct SleepSummary {
        let totalHours: Double
        let baselineHours: Double?
        let coreHours: Double?
        let deepHours: Double?
        let remHours: Double?
        let awakeHours: Double?
        let endDate: Date?
    }

    private struct SleepInterval {
        let start: Date
        let end: Date
        let value: Int
    }

    private func fetchSleepSummary(startDate: Date, endDate: Date, completion: @escaping (SleepSummary) -> Void) {
        guard let type = HKObjectType.categoryType(forIdentifier: .sleepAnalysis) else {
            completion(SleepSummary(totalHours: 0, baselineHours: nil, coreHours: nil, deepHours: nil, remHours: nil, awakeHours: nil, endDate: nil))
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            if let error = error {
                NSLog("ForgeHealthPlugin sleep query failed: %@", error.localizedDescription)
                completion(SleepSummary(totalHours: 0, baselineHours: nil, coreHours: nil, deepHours: nil, remHours: nil, awakeHours: nil, endDate: nil))
                return
            }

            let intervals = (samples as? [HKCategorySample] ?? []).map {
                SleepInterval(start: $0.startDate, end: $0.endDate, value: $0.value)
            }
            let sleepSessions = self.groupSleepSessions(intervals.filter { self.isAsleep($0.value) })
            let nightSessions = sleepSessions.filter { self.sleepSeconds($0) >= 3 * 60 * 60 }
            let candidateSessions = nightSessions.isEmpty ? sleepSessions : nightSessions
            guard let latestSession = candidateSessions.last,
                  let sessionStart = latestSession.map(\.start).min(),
                  let sessionEnd = latestSession.map(\.end).max() else {
                completion(SleepSummary(totalHours: 0, baselineHours: nil, coreHours: nil, deepHours: nil, remHours: nil, awakeHours: nil, endDate: nil))
                return
            }

            let latestSeconds = self.sleepSeconds(latestSession)
            let recentSessionHours = candidateSessions.dropLast().suffix(7).map { self.sleepSeconds($0) / 3600.0 }
            let baseline = recentSessionHours.count >= 3 ? recentSessionHours.reduce(0, +) / Double(recentSessionHours.count) : nil
            var coreSeconds: Double?
            var deepSeconds: Double?
            var remSeconds: Double?
            var awakeSeconds: Double?
            if #available(iOS 16.0, *) {
                coreSeconds = self.sleepStageSeconds(intervals, value: HKCategoryValueSleepAnalysis.asleepCore.rawValue, startDate: sessionStart, endDate: sessionEnd)
                deepSeconds = self.sleepStageSeconds(intervals, value: HKCategoryValueSleepAnalysis.asleepDeep.rawValue, startDate: sessionStart, endDate: sessionEnd)
                remSeconds = self.sleepStageSeconds(intervals, value: HKCategoryValueSleepAnalysis.asleepREM.rawValue, startDate: sessionStart, endDate: sessionEnd)
                awakeSeconds = self.sleepStageSeconds(intervals, value: HKCategoryValueSleepAnalysis.awake.rawValue, startDate: sessionStart, endDate: sessionEnd)

                let detailedTotal = (coreSeconds ?? 0) + (deepSeconds ?? 0) + (remSeconds ?? 0)
                if detailedTotal > latestSeconds, detailedTotal > 0 {
                    let scale = latestSeconds / detailedTotal
                    coreSeconds = (coreSeconds ?? 0) * scale
                    deepSeconds = (deepSeconds ?? 0) * scale
                    remSeconds = (remSeconds ?? 0) * scale
                }
            }

            completion(SleepSummary(
                totalHours: latestSeconds / 3600.0,
                baselineHours: baseline,
                coreHours: coreSeconds.map { $0 / 3600.0 },
                deepHours: deepSeconds.map { $0 / 3600.0 },
                remHours: remSeconds.map { $0 / 3600.0 },
                awakeHours: awakeSeconds.map { min($0, 8 * 60 * 60) / 3600.0 },
                endDate: sessionEnd
            ))
        }
        healthStore.execute(query)
    }

    private func groupSleepSessions(_ intervals: [SleepInterval]) -> [[SleepInterval]] {
        let sorted = intervals
            .filter { $0.end > $0.start }
            .sorted { $0.start < $1.start }
        guard !sorted.isEmpty else { return [] }

        let sessionGap: TimeInterval = 3 * 60 * 60
        var sessions: [[SleepInterval]] = []
        var currentSession: [SleepInterval] = []
        var latestEndInSession: Date?

        for interval in sorted {
            if let latestEnd = latestEndInSession, interval.start.timeIntervalSince(latestEnd) > sessionGap {
                sessions.append(currentSession)
                currentSession = [interval]
                latestEndInSession = interval.end
                continue
            }

            currentSession.append(interval)
            if let latestEnd = latestEndInSession {
                latestEndInSession = max(latestEnd, interval.end)
            } else {
                latestEndInSession = interval.end
            }
        }

        if !currentSession.isEmpty {
            sessions.append(currentSession)
        }
        return sessions
    }

    private func sleepSeconds(_ intervals: [SleepInterval]) -> Double {
        let mergedSeconds = mergeSleepIntervals(intervals).reduce(0.0) { sum, interval in
            sum + interval.end.timeIntervalSince(interval.start)
        }
        return min(max(mergedSeconds, 0), 12 * 60 * 60)
    }

    private func sleepStageSeconds(_ intervals: [SleepInterval], value: Int, startDate: Date, endDate: Date) -> Double {
        let clipped = intervals.compactMap { interval -> SleepInterval? in
            guard interval.value == value else { return nil }
            let start = max(interval.start, startDate)
            let end = min(interval.end, endDate)
            guard end > start else { return nil }
            return SleepInterval(start: start, end: end, value: value)
        }
        return mergeSleepIntervals(clipped).reduce(0.0) { $0 + $1.end.timeIntervalSince($1.start) }
    }

    private func mergeSleepIntervals(_ intervals: [SleepInterval]) -> [SleepInterval] {
        let sorted = intervals.sorted { $0.start < $1.start }
        var merged: [SleepInterval] = []

        for interval in sorted {
            guard let last = merged.last else {
                merged.append(interval)
                continue
            }

            if interval.start <= last.end {
                let end = max(last.end, interval.end)
                merged[merged.count - 1] = SleepInterval(start: last.start, end: end, value: last.value)
            } else {
                merged.append(interval)
            }
        }

        return merged
    }

    private func isAsleep(_ value: Int) -> Bool {
        if #available(iOS 16.0, *) {
            return HKCategoryValueSleepAnalysis.allAsleepValues.contains { $0.rawValue == value }
        }
        return value == HKCategoryValueSleepAnalysis.asleep.rawValue
    }

    private struct RunningDynamicsSummary {
        var powerWatts: Double?
        var speedMps: Double?
        var strideLengthM: Double?
        var verticalOscillationCm: Double?
        var groundContactTimeMs: Double?
        var recordedAt: Date?
    }

    private func fetchRunningDynamics(workout: HKWorkout, completion: @escaping (RunningDynamicsSummary) -> Void) {
        guard #available(iOS 16.0, *) else {
            completion(RunningDynamicsSummary())
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var summary = RunningDynamicsSummary()
        let queries: [(HKQuantityTypeIdentifier, HKUnit, (Double) -> Void)] = [
            (.runningPower, HKUnit.watt(), { summary.powerWatts = $0 }),
            (.runningSpeed, HKUnit.meter().unitDivided(by: HKUnit.second()), { summary.speedMps = $0 }),
            (.runningStrideLength, HKUnit.meter(), { summary.strideLengthM = $0 }),
            (.runningVerticalOscillation, HKUnit.meterUnit(with: .centi), { summary.verticalOscillationCm = $0 }),
            (.runningGroundContactTime, HKUnit.secondUnit(with: .milli), { summary.groundContactTimeMs = $0 })
        ]

        for (identifier, unit, assign) in queries {
            group.enter()
            averageQuantity(identifier, unit: unit, startDate: workout.startDate, endDate: workout.endDate) { value in
                if let value = value {
                    lock.lock()
                    assign(value)
                    lock.unlock()
                }
                group.leave()
            }
        }

        group.notify(queue: .global(qos: .userInitiated)) {
            if summary.powerWatts != nil || summary.speedMps != nil || summary.strideLengthM != nil || summary.verticalOscillationCm != nil || summary.groundContactTimeMs != nil {
                summary.recordedAt = workout.endDate
            }
            completion(summary)
        }
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

    private func fetchAnchoredWorkoutHistory(startDate: Date, endDate: Date, forceFullSync: Bool, completion: @escaping ([HKWorkout], HKQueryAnchor?, Bool, Error?) -> Void) {
        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let storedAnchor = forceFullSync ? nil : loadWorkoutAnchor()
        let query = HKAnchoredObjectQuery(
            type: HKObjectType.workoutType(),
            predicate: predicate,
            anchor: storedAnchor,
            limit: HKObjectQueryNoLimit
        ) { _, samples, _, newAnchor, error in
            if let error = error {
                completion([], nil, storedAnchor != nil, error)
                return
            }
            let workouts = (samples as? [HKWorkout] ?? []).sorted { $0.endDate > $1.endDate }
            completion(workouts, newAnchor, storedAnchor != nil, nil)
        }
        healthStore.execute(query)
    }

    private struct WorkoutHeartRateSummary {
        let avgHR: Double?
        let maxHR: Double?
        let zoneSeconds: [String: Int]
    }

    private func enrichWorkoutsWithHeartRate(_ workouts: [HKWorkout], suppliedMaxHR: Double?, completion: @escaping ([[String: Any]], Double?) -> Void) {
        guard !workouts.isEmpty else {
            completion([], nil)
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var summaries: [UUID: WorkoutHeartRateSummary] = [:]
        var observedMaxHR: Double?

        for workout in workouts {
            group.enter()
            fetchHeartRateSamples(startDate: workout.startDate, endDate: workout.endDate) { samples in
                let maxHR = samples.map { $0.bpm }.max()
                let avgHR = samples.isEmpty ? nil : samples.reduce(0.0) { $0 + $1.bpm } / Double(samples.count)

                lock.lock()
                if let maxHR = maxHR {
                    observedMaxHR = max(observedMaxHR ?? maxHR, maxHR)
                }
                summaries[workout.uuid] = WorkoutHeartRateSummary(avgHR: avgHR, maxHR: maxHR, zoneSeconds: [:])
                lock.unlock()
                group.leave()
            }
        }

        group.notify(queue: .global(qos: .userInitiated)) {
            let zoneMaxHR = suppliedMaxHR ?? observedMaxHR
            let zoneGroup = DispatchGroup()

            if let zoneMaxHR = zoneMaxHR, zoneMaxHR > 0 {
                for workout in workouts {
                    zoneGroup.enter()
                    self.fetchHeartRateSamples(startDate: workout.startDate, endDate: workout.endDate) { samples in
                        let zoneSeconds = self.bucketHeartRateSamples(samples, workout: workout, maxHR: zoneMaxHR)
                        lock.lock()
                        let existing = summaries[workout.uuid]
                        summaries[workout.uuid] = WorkoutHeartRateSummary(avgHR: existing?.avgHR, maxHR: existing?.maxHR, zoneSeconds: zoneSeconds)
                        lock.unlock()
                        zoneGroup.leave()
                    }
                }
            }

            zoneGroup.notify(queue: .global(qos: .userInitiated)) {
                let rows = workouts.map { workout -> [String: Any] in
                    let summary = summaries[workout.uuid]
                    return self.serializeWorkout(
                        workout,
                        avgHR: summary?.avgHR,
                        maxHR: summary?.maxHR,
                        zoneSeconds: summary?.zoneSeconds ?? self.emptyZoneSeconds()
                    )
                }
                completion(rows, observedMaxHR)
            }
        }
    }

    private struct HeartRatePoint {
        let date: Date
        let bpm: Double
    }

    private func fetchHeartRateSamples(startDate: Date, endDate: Date, completion: @escaping ([HeartRatePoint]) -> Void) {
        guard let type = HKQuantityType.quantityType(forIdentifier: .heartRate) else {
            completion([])
            return
        }

        let predicate = HKQuery.predicateForSamples(withStart: startDate, end: endDate, options: .strictStartDate)
        let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)
        let query = HKSampleQuery(sampleType: type, predicate: predicate, limit: HKObjectQueryNoLimit, sortDescriptors: [sort]) { _, samples, error in
            guard error == nil else {
                completion([])
                return
            }

            let unit = HKUnit.count().unitDivided(by: HKUnit.minute())
            let points = (samples as? [HKQuantitySample] ?? []).map {
                HeartRatePoint(date: $0.startDate, bpm: $0.quantity.doubleValue(for: unit))
            }
            completion(points)
        }
        healthStore.execute(query)
    }

    private func emptyZoneSeconds() -> [String: Int] {
        return ["z1": 0, "z2": 0, "z3": 0, "z4": 0, "z5": 0]
    }

    private func bucketHeartRateSamples(_ samples: [HeartRatePoint], workout: HKWorkout, maxHR: Double) -> [String: Int] {
        guard maxHR > 0, !samples.isEmpty else {
            return emptyZoneSeconds()
        }

        var zones = emptyZoneSeconds()
        for (index, sample) in samples.enumerated() {
            let nextDate = index + 1 < samples.count ? samples[index + 1].date : workout.endDate
            let rawSeconds = nextDate.timeIntervalSince(sample.date)
            let seconds = Int(max(1, min(rawSeconds, 30)).rounded())
            let pct = sample.bpm / maxHR
            let zone: String?
            if pct >= 0.9 {
                zone = "z5"
            } else if pct >= 0.8 {
                zone = "z4"
            } else if pct >= 0.7 {
                zone = "z3"
            } else if pct >= 0.6 {
                zone = "z2"
            } else if pct >= 0.5 {
                zone = "z1"
            } else {
                zone = nil
            }
            if let zone = zone {
                zones[zone] = (zones[zone] ?? 0) + seconds
            }
        }
        return zones
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

    private func serializeWorkout(_ workout: HKWorkout, avgHR: Double? = nil, maxHR: Double? = nil, zoneSeconds: [String: Int]? = nil) -> [String: Any] {
        let distanceMiles = workout.totalDistance?.doubleValue(for: HKUnit.mile()) ?? 0
        let calories = workout.totalEnergyBurned?.doubleValue(for: HKUnit.kilocalorie()) ?? 0

        var payload: [String: Any] = [
            "id": workout.uuid.uuidString,
            "date": isoDate(workout.startDate),
            "startDate": isoDateTime(workout.startDate),
            "endDate": isoDateTime(workout.endDate),
            "type": workoutTypeName(workout.workoutActivityType),
            "distanceMiles": round(distanceMiles * 1000) / 1000,
            "durationSeconds": Int(workout.duration.rounded()),
            "calories": Int(calories.rounded()),
            "source": "apple_health"
        ]
        payload["avgHR"] = avgHR.map { Int($0.rounded()) } ?? NSNull()
        payload["maxHR"] = maxHR.map { Int($0.rounded()) } ?? NSNull()
        payload["zoneSeconds"] = zoneSeconds ?? emptyZoneSeconds()
        return payload
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

    private func parseDate(_ value: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) {
            return date
        }
        formatter.formatOptions = [.withInternetDateTime]
        if let date = formatter.date(from: value) {
            return date
        }
        let dayFormatter = DateFormatter()
        dayFormatter.calendar = Calendar(identifier: .iso8601)
        dayFormatter.locale = Locale(identifier: "en_US_POSIX")
        dayFormatter.timeZone = TimeZone.current
        dayFormatter.dateFormat = "yyyy-MM-dd"
        return dayFormatter.date(from: value)
    }

    private func saveWorkoutAnchor(_ anchor: HKQueryAnchor) {
        do {
            let data = try NSKeyedArchiver.archivedData(withRootObject: anchor, requiringSecureCoding: true)
            UserDefaults.standard.set(data.base64EncodedString(), forKey: workoutAnchorKey)
        } catch {
            NSLog("ForgeHealthPlugin failed to save workout anchor: %@", error.localizedDescription)
        }
    }

    private func loadWorkoutAnchor() -> HKQueryAnchor? {
        guard let encoded = UserDefaults.standard.string(forKey: workoutAnchorKey),
              let data = Data(base64Encoded: encoded) else {
            return nil
        }

        do {
            return try NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: data)
        } catch {
            NSLog("ForgeHealthPlugin failed to load workout anchor: %@", error.localizedDescription)
            return nil
        }
    }
}
