import { Platform } from 'react-native';
import AppleHealthKit from 'react-native-health';

const permissions = {
  permissions: {
    read: [
      AppleHealthKit.Constants.Permissions.Workout
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
