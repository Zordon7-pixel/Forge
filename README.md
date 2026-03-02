# FORGE Native

## Phase 3: Apple Watch + Wear OS Companion

Phase 3 adds wearable companion bridges for live workout telemetry and remote workout controls.

### Implemented in app code

- `src/watch/WatchBridge.js`
  - iOS-only bridge around `react-native-watch-connectivity`
  - Handles activation state, pairing/install/reachability listeners
  - Sends workout update payloads (`pace`, `distance`, `heartRate`, `elapsed`, `summary`)
  - Receives watch controls (`start`, `pause`, `stop`) from watch messages
- `src/watch/WearBridge.js`
  - Android-only bridge around `react-native-wear-connectivity`
  - Sends same workout payload contract as iOS bridge
  - Receives Wear OS controls (`start`, `pause`, `stop`) from watch messages
- `src/services/WorkoutBroadcast.js`
  - Singleton broadcaster used by workout screens
  - Broadcasts active workout updates every 5 seconds
  - Routes to Apple Watch bridge on iOS and Wear bridge on Android
- `src/screens/LogRun.js`
  - Starts broadcasting when tracking starts/resumes
  - Stops broadcasting when paused/stopped/saved/unmounted
  - Subscribes to remote watch controls for start/pause/stop
  - Shows watch connectivity indicator with `lucide-react-native` watch icon
- `src/screens/LogLift.js`
  - Starts broadcasting once the lift session input begins
  - Stops broadcasting on save/unmount

### Package note (requested package names)

The requested packages `@watch-connectivity/react-native` and `@react-native-wear-connectivity` are not published under those names on npm as of March 2, 2026.

Used alternatives:
- `react-native-watch-connectivity`
- `react-native-wear-connectivity`

## Apple Watch setup (iOS)

### 1. Install dependencies

```bash
npm install react-native-watch-connectivity
```

### 2. Create native iOS project files (Expo)

If you are in managed Expo and have not generated native folders yet:

```bash
npx expo prebuild -p ios
```

### 3. Add WatchKit target in Xcode

1. Open `ios/*.xcworkspace` in Xcode.
2. Add a Watch App target and Watch Extension target.
3. Confirm iOS app + watch extension use the same Team and bundle ID family.

Xcode guide:
- https://developer.apple.com/documentation/watchkit/setting_up_a_watchos_project

### 4. Enable WatchConnectivity

In the watch extension, import and configure `WatchConnectivity` with a `WCSession` delegate.

Apple docs:
- https://developer.apple.com/documentation/watchconnectivity

### 5. Entitlements/capabilities

- Enable required signing/capabilities for iOS app and watch extension.
- Ensure both targets are signed and installed together from Xcode.

### 6. Pairing and test flow

1. Run iOS app on a real device or paired simulator setup.
2. Pair Apple Watch with iPhone.
3. Install/run both app and watch extension.
4. Verify watch receives `workout_update` payload and can send `start|pause|stop` control messages.

## Wear OS setup (Android)

### 1. Install dependencies

```bash
npm install react-native-wear-connectivity
```

### 2. Create native Android project files (Expo)

```bash
npx expo prebuild -p android
```

### 3. Update Android manifest

Add Wear connectivity permissions and service in `android/app/src/main/AndroidManifest.xml` per library docs:
- https://github.com/fabOnReact/react-native-wear-connectivity

### 4. Build a Wear OS app target

Create the Wear OS companion app in Android Studio (Jetpack Compose or native Android), and ensure:

- Same package/application ID family as phone app
- Same signing key as phone app
- Message payload contract matches phone bridge (`type`, `action`, `pace`, `distance`, `heartRate`, `elapsed`, `summary`)

### 5. Pairing and test flow

1. Pair Wear OS device/emulator with Android phone/emulator.
2. Install phone + watch apps.
3. Confirm phone sends `workout_update` every 5 seconds during active workout.
4. Confirm watch sends `start|pause|stop` control messages back to phone.

## Data contract

Outgoing `workout_update` payload includes:

```json
{
  "type": "workout_update",
  "workoutType": "run|lift",
  "status": "running|paused|stopped",
  "pace": "7:45",
  "distance": 2.31,
  "heartRate": 152,
  "elapsed": 812,
  "summary": "2.31 mi • 7:45/mi • 152 bpm • 13:32",
  "timestamp": "2026-03-02T05:00:00.000Z"
}
```

Incoming control payload expected from watch:

```json
{
  "type": "workout_control",
  "action": "start|pause|stop"
}
```

## TODOs for production hardening

- Add explicit watch app UI implementation for complication/watch face rendering of `summary`.
- Add heart-rate sensor streaming to populate `heartRate` on phone side.
- Add retry/backoff queue when wearable is temporarily unreachable.
- Add E2E tests across phone/watch simulator pairings.
