import type { AggregateRequest, AggregateResult, AggregateGroupByDurationRequest, AggregateGroupByPeriodRequest, AggregationGroupResult, AggregateResultRecordType, HealthConnectRecord, Permission, ReadRecordsOptions, RecordResult, RecordType, ReadRecordsResult, GetChangesRequest, GetChangesResults, WriteExerciseRoutePermission, ReadHealthDataHistoryPermission, BackgroundAccessPermission, RevokeAllPermissionsResponse } from './types';
import type { ExerciseRoute, TimeRangeFilter } from './types/base.types';
/**
 * Gets the status of the Health Connect SDK
 * @param providerPackageName the package name of the Health Connect provider
 * @returns the status of the SDK - check SdkAvailabilityStatus constants
 */
export declare function getSdkStatus(providerPackageName?: string): Promise<number>;
/**
 * Initializes the Health Connect SDK
 * @param providerPackageName the package name of the Health Connect provider
 * @returns true if the SDK was initialized successfully
 */
export declare function initialize(providerPackageName?: string): Promise<boolean>;
/**
 * Opens Health Connect settings app
 */
export declare function openHealthConnectSettings(): void;
/**
 * Opens Health Connect data management screen
 */
export declare function openHealthConnectDataManagement(providerPackageName?: string): void;
/**
 * Request permissions to access Health Connect data
 * @param permissions list of permissions to request
 * @returns granted permissions, including special permissions like WriteExerciseRoutePermission and BackgroundAccessPermission
 */
export declare function requestPermission(permissions: (Permission | WriteExerciseRoutePermission | BackgroundAccessPermission | ReadHealthDataHistoryPermission)[]): Promise<(Permission | WriteExerciseRoutePermission | ReadHealthDataHistoryPermission | BackgroundAccessPermission)[]>;
export declare function requestExerciseRoute(recordId: string): Promise<ExerciseRoute>;
/**
 * Returns a set of all health permissions granted by the user to the calling app.
 * This includes regular permissions as well as special permissions like WriteExerciseRoutePermission and BackgroundAccessPermission.
 * @returns A promise that resolves to an array of granted permissions
 */
export declare function getGrantedPermissions(): Promise<(Permission | WriteExerciseRoutePermission | BackgroundAccessPermission)[]>;
/**
 * Revokes all previously granted permissions by the user to the calling app.
 * On Android 14+, permissions are not immediately revoked. They will be revoked when the app restarts.
 * @returns A promise that resolves to a RevokeAllPermissionsResponse object containing information about the revocation status,
 * or void for backward compatibility with older versions
 */
export declare function revokeAllPermissions(): Promise<RevokeAllPermissionsResponse | void>;
export declare function readRecords<T extends RecordType>(recordType: T, options: ReadRecordsOptions): Promise<ReadRecordsResult<T>>;
export declare function readRecord<T extends RecordType>(recordType: T, recordId: string): Promise<RecordResult<T>>;
export declare function insertRecords(records: HealthConnectRecord[]): Promise<string[]>;
export declare function aggregateRecord<T extends AggregateResultRecordType>(request: AggregateRequest<T>): Promise<AggregateResult<T>>;
export declare function aggregateGroupByDuration<T extends AggregateResultRecordType>(request: AggregateGroupByDurationRequest<T>): Promise<AggregationGroupResult<T>[]>;
export declare function aggregateGroupByPeriod<T extends AggregateResultRecordType>(request: AggregateGroupByPeriodRequest<T>): Promise<AggregationGroupResult<T>[]>;
export declare function getChanges(request: GetChangesRequest): Promise<GetChangesResults>;
export declare function deleteRecordsByUuids(recordType: RecordType, recordIdsList: string[], clientRecordIdsList: string[]): Promise<void>;
export declare function deleteRecordsByTimeRange(recordType: RecordType, timeRangeFilter: TimeRangeFilter): Promise<void>;
export * from './constants';
export * from './types';
//# sourceMappingURL=index.d.ts.map