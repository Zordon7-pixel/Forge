export const FORGED_IOS_APP_ID = 'com.zordontech.forge'

function parseStrictInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!/^[+-]?\d+$/.test(normalized)) return null
  const parsed = Number(normalized)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function buildNativeIosAppOpenProps(appInfo, timezoneOffsetMinutes) {
  const buildNumber = parseStrictInteger(appInfo?.build)
  const offset = parseStrictInteger(timezoneOffsetMinutes)
  const version = typeof appInfo?.version === 'string' ? appInfo.version.trim() : ''
  if (appInfo?.id !== FORGED_IOS_APP_ID
    || !version
    || buildNumber === null
    || buildNumber <= 0
    || offset === null
    || Math.abs(offset) > 840) {
    throw new Error('Native iOS app identity is incomplete')
  }
  return {
    app_id: FORGED_IOS_APP_ID,
    app_version: version,
    build_number: buildNumber,
    native_runtime: true,
    platform: 'ios_native',
    timezone_offset_minutes: offset,
  }
}

export async function emitAppOpenTelemetry({ capacitor, capacitorApp, track, now = new Date() }) {
  const nativeRuntime = Boolean(capacitor?.isNativePlatform?.())
  if (!nativeRuntime) {
    return track('app_open', { native_runtime: false, platform: 'web' })
  }

  const platform = capacitor?.getPlatform?.()
  if (platform !== 'ios') {
    return track('app_open', {
      native_runtime: true,
      platform: `${platform || 'unknown'}_native`,
    })
  }

  const appInfo = await capacitorApp.getInfo()
  const props = buildNativeIosAppOpenProps(appInfo, now.getTimezoneOffset())
  return track('app_open', props)
}
