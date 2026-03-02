import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';

import * as healthIOS from '../lib/health';
import * as healthAndroid from '../lib/healthAndroid';

const getHealthProvider = () => (Platform.OS === 'android' ? healthAndroid : healthIOS);

export default function useHealthData() {
  const [workouts, setWorkouts] = useState([]);
  const [steps, setSteps] = useState(0);
  const [heartRate, setHeartRate] = useState(null);
  const [hrv, setHrv] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastSynced, setLastSynced] = useState(null);

  const refresh = useCallback(async () => {
    const provider = getHealthProvider();
    setLoading(true);
    setError(null);

    try {
      const [recentWorkouts, dailySteps, heartRateData] = await Promise.all([
        provider.getRecentWorkouts(),
        provider.getDailySteps(),
        provider.getHeartRateData()
      ]);

      setWorkouts(recentWorkouts || []);
      setSteps(Number(dailySteps || 0));
      setHeartRate(heartRateData?.heartRate ?? null);
      setHrv(heartRateData?.hrv ?? null);
      setLastSynced(new Date().toISOString());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const provider = getHealthProvider();

    const initialize = async () => {
      try {
        await provider.requestPermissions();
        await refresh();
      } catch (err) {
        setError(err);
      }
    };

    initialize();
  }, [refresh]);

  return {
    workouts,
    steps,
    heartRate,
    hrv,
    loading,
    error,
    lastSynced,
    refresh
  };
}
