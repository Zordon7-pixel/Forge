import { Platform } from 'react-native';
import AppleHealthKit from 'react-native-health';

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

const hrvPermission =
  AppleHealthKit.Constants.Permissions.HeartRateVariability ||
  AppleHealthKit.Constants.Permissions.HeartRateVariabilitySDNN ||
  'HeartRateVariabilitySDNN';

const permissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.Workout,
      AppleHealthKit.Constants.Permissions.Steps,
      AppleHealthKit.Constants.Permissions.HeartRate,
      hrvPermission,
      AppleHealthKit.Constants.Permissions.ActiveEnergyBurned
    ],
    write: [
      AppleHealthKit.Constants.Permissions.Workout
    ]
  }
};

const toISOString = (date) => {
  if (!date) return new Date().toISOString();
  return new Date(date).toISOString();
};

const callHealthKit = (method, options = {}) =>
  new Promise((resolve, reject) => {
    if (typeof AppleHealthKit[method] !== 'function') {
      resolve([]);
      return;
    }

    AppleHealthKit[method](options, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(result);
    });
  });

export const requestPermissions = async () => {
  if (Platform.OS !== 'ios') return false;

  // Apple Health integration requires an iOS EAS build; Expo Go does not support this native module.
  return new Promise((resolve, reject) => {
    AppleHealthKit.initHealthKit(permissions, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(true);
    });
  });
};

export const getRecentWorkouts = async () => {
  if (Platform.OS !== 'ios') return [];

  const { startDate, endDate } = getDateRange(30);
  const anchored = await callHealthKit('getAnchoredWorkouts', {
    startDate,
    endDate,
    type: 'Workout'
  });

  const workouts = anchored?.data || [];
  const validActivities = new Set(['Running', 'TraditionalStrengthTraining']);

  return workouts
    .filter((item) => validActivities.has(item.activityName))
    .map((item) => ({
      id: item.id,
      type: item.activityName === 'Running' ? 'run' : 'strength',
      title: item.activityName === 'Running' ? 'Run' : 'Strength Training',
      startDate: item.start,
      endDate: item.end,
      duration: Number(item.duration || 0),
      calories: Number(item.calories || 0),
      distanceMiles: Number(item.distance || 0),
      source: 'health'
    }))
    .sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
};

export const getDailySteps = async () => {
  if (Platform.OS !== 'ios') return 0;

  const stepSamples = await callHealthKit('getDailyStepCountSamples', getStartAndEndOfToday());
  return (stepSamples || []).reduce((total, sample) => total + Number(sample?.value || 0), 0);
};

export const getHeartRateData = async () => {
  if (Platform.OS !== 'ios') {
    return {
      heartRate: null,
      hrv: null,
      activeEnergyBurned: 0
    };
  }

  const { startDate, endDate } = getDateRange(30);

  const [restingHeartRateSamples, heartRateVariabilitySamples, activeEnergySamples] = await Promise.all([
    callHealthKit('getRestingHeartRateSamples', {
      unit: 'bpm',
      startDate,
      endDate,
      ascending: false,
      limit: 30
    }),
    callHealthKit('getHeartRateVariabilitySamples', {
      unit: 'second',
      startDate,
      endDate,
      ascending: false,
      limit: 30
    }),
    callHealthKit('getActiveEnergyBurned', {
      startDate,
      endDate,
      ascending: false
    })
  ]);

  const sortedResting = [...(restingHeartRateSamples || [])].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );
  const sortedHrv = [...(heartRateVariabilitySamples || [])].sort(
    (a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
  );

  return {
    heartRate: sortedResting[0]?.value ?? null,
    hrv: sortedHrv[0]?.value ?? null,
    activeEnergyBurned: (activeEnergySamples || []).reduce(
      (total, sample) => total + Number(sample?.value || 0),
      0
    )
  };
};

export const syncRunToHealth = async (run) => {
  if (Platform.OS !== 'ios') return false;

  const startDate = toISOString(run?.date);
  const endDate = new Date(new Date(startDate).getTime() + (run?.duration || 0) * 1000).toISOString();

  const workout = {
    type: 'Running',
    startDate,
    endDate,
    energyBurned: run?.calories || 0,
    energyBurnedUnit: 'kcal',
    distance: run?.distance ? Number(run.distance) * 1609.34 : 0,
    distanceUnit: 'meter'
  };

  return new Promise((resolve, reject) => {
    AppleHealthKit.saveWorkout(workout, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(true);
    });
  });
};

export const syncLiftToHealth = async (workout) => {
  if (Platform.OS !== 'ios') return false;

  const startDate = toISOString(workout?.date);
  const durationSeconds = 45 * 60;
  const endDate = new Date(new Date(startDate).getTime() + durationSeconds * 1000).toISOString();

  const payload = {
    type: 'TraditionalStrengthTraining',
    startDate,
    endDate,
    energyBurned: 0,
    energyBurnedUnit: 'kcal'
  };

  return new Promise((resolve, reject) => {
    AppleHealthKit.saveWorkout(payload, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(true);
    });
  });
};
