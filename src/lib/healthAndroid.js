import { Platform } from 'react-native';
import {
  ExerciseType,
  SdkAvailabilityStatus,
  getSdkStatus,
  initialize,
  readRecords,
  requestPermission
} from 'react-native-health-connect';

const getDateRange = (days = 30) => {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString()
  };
};

const getStartAndEndOfToday = () => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return {
    startDate: start.toISOString(),
    endDate: end.toISOString()
  };
};

const ensureInitialized = async () => {
  const status = await getSdkStatus();

  if (status !== SdkAvailabilityStatus.SDK_AVAILABLE) {
    throw new Error('Health Connect is not available on this device.');
  }

  const initialized = await initialize();
  if (!initialized) {
    throw new Error('Failed to initialize Health Connect.');
  }
};

export const requestPermissions = async () => {
  if (Platform.OS !== 'android') return false;

  await ensureInitialized();

  return requestPermission([
    { accessType: 'read', recordType: 'Steps' },
    { accessType: 'read', recordType: 'ExerciseSession' },
    { accessType: 'read', recordType: 'HeartRate' },
    { accessType: 'read', recordType: 'ActiveCaloriesBurned' }
  ]);
};

export const getRecentWorkouts = async () => {
  if (Platform.OS !== 'android') return [];

  await ensureInitialized();
  const { startDate, endDate } = getDateRange(30);

  const response = await readRecords('ExerciseSession', {
    timeRangeFilter: {
      operator: 'between',
      startTime: startDate,
      endTime: endDate
    },
    ascendingOrder: false,
    pageSize: 200
  });

  const strengthTypes = new Set([ExerciseType.STRENGTH_TRAINING, ExerciseType.WEIGHTLIFTING]);
  const runningTypes = new Set([ExerciseType.RUNNING, ExerciseType.RUNNING_TREADMILL]);

  return (response?.records || [])
    .filter((session) => runningTypes.has(session.exerciseType) || strengthTypes.has(session.exerciseType))
    .map((session) => ({
      id: session?.metadata?.id || `${session.startTime}-${session.endTime}`,
      type: runningTypes.has(session.exerciseType) ? 'run' : 'strength',
      title: runningTypes.has(session.exerciseType) ? 'Run' : 'Strength Training',
      startDate: session.startTime,
      endDate: session.endTime,
      duration: Math.max(0, Math.floor((new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000)),
      calories: 0,
      distanceMiles: 0,
      source: 'health'
    }))
    .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
};

export const getDailySteps = async () => {
  if (Platform.OS !== 'android') return 0;

  await ensureInitialized();
  const { startDate, endDate } = getStartAndEndOfToday();

  const response = await readRecords('Steps', {
    timeRangeFilter: {
      operator: 'between',
      startTime: startDate,
      endTime: endDate
    },
    ascendingOrder: false,
    pageSize: 500
  });

  return (response?.records || []).reduce((total, record) => total + Number(record?.count || 0), 0);
};

export const getHeartRateData = async () => {
  if (Platform.OS !== 'android') {
    return {
      heartRate: null,
      hrv: null,
      activeEnergyBurned: 0
    };
  }

  await ensureInitialized();
  const { startDate, endDate } = getDateRange(30);

  const [heartRateResponse, activeCaloriesResponse] = await Promise.all([
    readRecords('HeartRate', {
      timeRangeFilter: {
        operator: 'between',
        startTime: startDate,
        endTime: endDate
      },
      ascendingOrder: false,
      pageSize: 100
    }),
    readRecords('ActiveCaloriesBurned', {
      timeRangeFilter: {
        operator: 'between',
        startTime: startDate,
        endTime: endDate
      },
      ascendingOrder: false,
      pageSize: 300
    })
  ]);

  const latestHeartRate = (heartRateResponse?.records || [])
    .flatMap((record) => record.samples || [])
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())[0];

  const activeEnergyBurned = (activeCaloriesResponse?.records || []).reduce(
    (total, record) => total + Number(record?.energy?.inKilocalories || 0),
    0
  );

  return {
    heartRate: latestHeartRate?.beatsPerMinute ?? null,
    hrv: null,
    activeEnergyBurned
  };
};
