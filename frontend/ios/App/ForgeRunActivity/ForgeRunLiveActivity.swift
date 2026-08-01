import ActivityKit
import SwiftUI
import WidgetKit

struct ForgeRunLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ForgeRunAttributes.self) { context in
            ForgeRunLockScreenView(context: context)
                .activityBackgroundTint(Color(red: 0.047, green: 0.039, blue: 0.027))
                .activitySystemActionForegroundColor(.white)
                .widgetURL(URL(string: "forgedhybrid://run/active"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ForgeRunBrandMark()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    ForgeElapsedTime(startedAtEpochMs: context.state.timerStartDateEpochMs, elapsedSeconds: context.state.elapsedSeconds, isPaused: context.state.isPaused, font: .title3)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .lineLimit(1)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    ForgeRunMetrics(context: context, compact: true)
                }
            } compactLeading: {
                Image(systemName: "figure.run")
                    .foregroundStyle(.yellow)
            } compactTrailing: {
                ForgeElapsedTime(startedAtEpochMs: context.state.timerStartDateEpochMs, elapsedSeconds: context.state.elapsedSeconds, isPaused: context.state.isPaused, font: .caption)
                    .frame(maxWidth: 58)
            } minimal: {
                Image(systemName: "figure.run")
                    .foregroundStyle(.yellow)
            }
            .widgetURL(URL(string: "forgedhybrid://run/active"))
            .keylineTint(.yellow)
        }
    }
}

private struct ForgeRunLockScreenView: View {
    let context: ActivityViewContext<ForgeRunAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                ForgeRunBrandMark()
                Spacer(minLength: 8)
                Label(gpsLabel, systemImage: gpsSymbol)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(gpsColor)
            }

            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(context.attributes.title)
                        .font(.headline)
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if !context.attributes.targetLabel.isEmpty {
                        Text(context.attributes.targetLabel)
                            .font(.caption)
                            .foregroundStyle(Color.white.opacity(0.68))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                ForgeElapsedTime(startedAtEpochMs: context.state.timerStartDateEpochMs, elapsedSeconds: context.state.elapsedSeconds, isPaused: context.state.isPaused, font: .title2)
            }

            ForgeRunMetrics(context: context, compact: false)

            Link(destination: controlURL) {
                Label(context.state.isPaused ? "Resume" : "Pause", systemImage: context.state.isPaused ? "play.fill" : "pause.fill")
                    .font(.caption.weight(.black))
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity, minHeight: 34)
                    .background(Color.yellow)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .padding(16)
    }

    private var gpsLabel: String {
        switch context.state.gpsState {
        case "tracking":
            return context.state.gpsAccuracyMeters >= 0 ? "GPS ±\(context.state.gpsAccuracyMeters)m" : "GPS active"
        case "paused": return "Run paused"
        case "off": return "Route off"
        default: return "Finding GPS"
        }
    }

    private var gpsSymbol: String {
        context.state.gpsState == "paused" ? "pause.fill" : context.state.gpsState == "tracking" ? "location.fill" : "location"
    }

    private var gpsColor: Color {
        context.state.gpsState == "tracking" ? Color.green : context.state.gpsState == "paused" ? Color.yellow : Color.white.opacity(0.58)
    }

    private var controlURL: URL {
        URL(string: "forgedhybrid://run/active?command=\(context.state.isPaused ? "resume" : "pause")")!
    }
}

private struct ForgeRunBrandMark: View {
    var body: some View {
        Label("FORGED HYBRID", systemImage: "figure.run")
            .font(.caption2.weight(.black))
            .foregroundStyle(.yellow)
            .lineLimit(1)
    }
}

private struct ForgeElapsedTime: View {
    let startedAtEpochMs: Double
    let elapsedSeconds: Int
    let isPaused: Bool
    let font: Font

    var body: some View {
        Group {
            if isPaused {
                Text(pausedTime)
            } else {
                Text(timerInterval: startDate...Date.distantFuture, countsDown: false)
            }
        }
        .font(font.weight(.black).monospacedDigit())
        .foregroundStyle(.white)
        .lineLimit(1)
    }

    private var startDate: Date {
        let timestamp = startedAtEpochMs > 0 ? startedAtEpochMs : Date().timeIntervalSince1970 * 1000
        return Date(timeIntervalSince1970: timestamp / 1000)
    }

    private var pausedTime: String {
        let hours = elapsedSeconds / 3600
        let minutes = (elapsedSeconds % 3600) / 60
        let seconds = elapsedSeconds % 60
        return hours > 0
            ? String(format: "%d:%02d:%02d", hours, minutes, seconds)
            : String(format: "%d:%02d", minutes, seconds)
    }
}

private struct ForgeRunMetrics: View {
    let context: ActivityViewContext<ForgeRunAttributes>
    let compact: Bool

    var body: some View {
        HStack(spacing: compact ? 18 : 0) {
            metric(label: "DISTANCE", value: distanceText)
            if !compact { Spacer(minLength: 8) }
            metric(label: "AVG PACE", value: paceText)
            if context.state.hrFresh && context.state.heartRate > 0 {
                if !compact { Spacer(minLength: 8) }
                metric(label: context.state.hrZoneKey.isEmpty ? "HEART RATE" : context.state.hrZoneKey, value: "\(context.state.heartRate) bpm", color: zoneColor)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func metric(label: String, value: String, color: Color = .white) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(Color.white.opacity(0.55))
            Text(value)
                .font((compact ? Font.caption : Font.callout).weight(.bold).monospacedDigit())
                .foregroundStyle(color)
                .lineLimit(1)
        }
    }

    private var distanceText: String {
        guard context.state.distance >= 0 else { return "Manual" }
        return String(format: "%.2f %@", context.state.distance, context.attributes.unit)
    }

    private var paceText: String {
        let seconds = context.state.paceSecPerUnit
        guard seconds > 0 else { return "--" }
        return String(format: "%d:%02d /%@", seconds / 60, seconds % 60, context.attributes.unit)
    }

    private var zoneColor: Color {
        Color(forgeHex: context.state.hrZoneColorHex) ?? .white
    }
}

private extension Color {
    init?(forgeHex: String) {
        let trimmed = forgeHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard trimmed.count == 6, let value = UInt64(trimmed, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
