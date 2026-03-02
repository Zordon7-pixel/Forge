"use strict";

Object.defineProperty(exports, "__esModule", {
  value: true
});
var _exportNames = {
  getSdkStatus: true,
  initialize: true,
  openHealthConnectSettings: true,
  openHealthConnectDataManagement: true,
  requestPermission: true,
  requestExerciseRoute: true,
  getGrantedPermissions: true,
  revokeAllPermissions: true,
  readRecords: true,
  readRecord: true,
  insertRecords: true,
  aggregateRecord: true,
  aggregateGroupByDuration: true,
  aggregateGroupByPeriod: true,
  getChanges: true,
  deleteRecordsByUuids: true,
  deleteRecordsByTimeRange: true
};
exports.aggregateGroupByDuration = aggregateGroupByDuration;
exports.aggregateGroupByPeriod = aggregateGroupByPeriod;
exports.aggregateRecord = aggregateRecord;
exports.deleteRecordsByTimeRange = deleteRecordsByTimeRange;
exports.deleteRecordsByUuids = deleteRecordsByUuids;
exports.getChanges = getChanges;
exports.getGrantedPermissions = getGrantedPermissions;
exports.getSdkStatus = getSdkStatus;
exports.initialize = initialize;
exports.insertRecords = insertRecords;
exports.openHealthConnectDataManagement = openHealthConnectDataManagement;
exports.openHealthConnectSettings = openHealthConnectSettings;
exports.readRecord = readRecord;
exports.readRecords = readRecords;
exports.requestExerciseRoute = requestExerciseRoute;
exports.requestPermission = requestPermission;
exports.revokeAllPermissions = revokeAllPermissions;
var _reactNative = require("react-native");
var _errors = require("./errors");
var _constants = require("./constants");
Object.keys(_constants).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _constants[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _constants[key];
    }
  });
});
var _types = require("./types");
Object.keys(_types).forEach(function (key) {
  if (key === "default" || key === "__esModule") return;
  if (Object.prototype.hasOwnProperty.call(_exportNames, key)) return;
  if (key in exports && exports[key] === _types[key]) return;
  Object.defineProperty(exports, key, {
    enumerable: true,
    get: function () {
      return _types[key];
    }
  });
});
const LINKING_ERROR = `The package 'react-native-health-connect' doesn't seem to be linked. Make sure: \n\n` + _reactNative.Platform.select({
  ios: "- You have run 'pod install'\n",
  default: ''
}) + '- You rebuilt the app after installing the package\n' + '- You are not using Expo Go\n';
const PLATFORM_NOT_SUPPORTED_ERROR = `Platform not supported. This package only supports Android.`;

// @ts-expect-error
const isTurboModuleEnabled = global.__turboModuleProxy != null;
const moduleProxy = message => new Proxy({}, {
  get() {
    throw new Error(message);
  }
});
const HealthConnectModule = _reactNative.Platform.select({
  android: isTurboModuleEnabled ? require('./NativeHealthConnect').default : _reactNative.NativeModules.HealthConnect,
  ios: moduleProxy(PLATFORM_NOT_SUPPORTED_ERROR),
  default: moduleProxy(PLATFORM_NOT_SUPPORTED_ERROR)
});
const HealthConnect = HealthConnectModule ? HealthConnectModule : moduleProxy(LINKING_ERROR);
const DEFAULT_PROVIDER_PACKAGE_NAME = 'com.google.android.apps.healthdata';

/**
 * Gets the status of the Health Connect SDK
 * @param providerPackageName the package name of the Health Connect provider
 * @returns the status of the SDK - check SdkAvailabilityStatus constants
 */
function getSdkStatus(providerPackageName = DEFAULT_PROVIDER_PACKAGE_NAME) {
  return HealthConnect.getSdkStatus(providerPackageName);
}

/**
 * Initializes the Health Connect SDK
 * @param providerPackageName the package name of the Health Connect provider
 * @returns true if the SDK was initialized successfully
 */
function initialize(providerPackageName = DEFAULT_PROVIDER_PACKAGE_NAME) {
  return HealthConnect.initialize(providerPackageName);
}

/**
 * Opens Health Connect settings app
 */
function openHealthConnectSettings() {
  return HealthConnect.openHealthConnectSettings();
}

/**
 * Opens Health Connect data management screen
 */
function openHealthConnectDataManagement(providerPackageName) {
  return HealthConnect.openHealthConnectDataManagement(providerPackageName);
}

/**
 * Request permissions to access Health Connect data
 * @param permissions list of permissions to request
 * @returns granted permissions, including special permissions like WriteExerciseRoutePermission and BackgroundAccessPermission
 */
function requestPermission(permissions) {
  return HealthConnect.requestPermission(permissions);
}
function requestExerciseRoute(recordId) {
  return HealthConnect.requestExerciseRoute(recordId);
}

/**
 * Returns a set of all health permissions granted by the user to the calling app.
 * This includes regular permissions as well as special permissions like WriteExerciseRoutePermission and BackgroundAccessPermission.
 * @returns A promise that resolves to an array of granted permissions
 */
function getGrantedPermissions() {
  return HealthConnect.getGrantedPermissions();
}

/**
 * Revokes all previously granted permissions by the user to the calling app.
 * On Android 14+, permissions are not immediately revoked. They will be revoked when the app restarts.
 * @returns A promise that resolves to a RevokeAllPermissionsResponse object containing information about the revocation status,
 * or void for backward compatibility with older versions
 */
function revokeAllPermissions() {
  return HealthConnect.revokeAllPermissions();
}
function readRecords(recordType, options) {
  return HealthConnect.readRecords(recordType, options);
}
function readRecord(recordType, recordId) {
  return HealthConnect.readRecord(recordType, recordId);
}
function insertRecords(records) {
  if (records.length === 0) {
    throw new _errors.HealthConnectError('You must provide at least one record', 'insertRecords');
  }
  const recordTypes = records.map(record => record.recordType);
  const uniqueRecordTypes = new Set(recordTypes);
  if (uniqueRecordTypes.size > 1) {
    throw new _errors.HealthConnectError('All records must have the same type', 'insertRecords');
  }
  return HealthConnect.insertRecords(records);
}
function aggregateRecord(request) {
  return HealthConnect.aggregateRecord(request);
}
function aggregateGroupByDuration(request) {
  return HealthConnect.aggregateGroupByDuration(request);
}
function aggregateGroupByPeriod(request) {
  return HealthConnect.aggregateGroupByPeriod(request);
}
function getChanges(request) {
  return HealthConnect.getChanges(request);
}
function deleteRecordsByUuids(recordType, recordIdsList, clientRecordIdsList) {
  return HealthConnect.deleteRecordsByUuids(recordType, recordIdsList, clientRecordIdsList);
}
function deleteRecordsByTimeRange(recordType, timeRangeFilter) {
  return HealthConnect.deleteRecordsByTimeRange(recordType, timeRangeFilter);
}
//# sourceMappingURL=index.js.map