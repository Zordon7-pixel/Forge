import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Activity, ChevronRight, Link2, LogOut, ShieldCheck } from 'lucide-react-native';

import api from '../lib/api';
import { requestPermissions } from '../lib/health';
import { AuthContext } from '../navigation/AppNavigator';
import { isConnected as isGarminConnected } from '../services/GarminConnect';

export default function Profile({ navigation }) {
  const { signOut } = useContext(AuthContext);
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [garminConnected, setGarminConnected] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const [runsRes, workoutsRes] = await Promise.all([api.get('/runs'), api.get('/workouts')]);
        setRuns(runsRes?.data?.runs || runsRes?.data || []);
        setWorkouts(workoutsRes?.data?.workouts || workoutsRes?.data || []);
      } catch {
        setRuns([]);
        setWorkouts([]);
      }
    };

    load();
  }, []);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const loadStatus = async () => {
        const connected = await isGarminConnected();
        if (active) {
          setGarminConnected(connected);
        }
      };
      loadStatus();

      return () => {
        active = false;
      };
    }, [])
  );

  const stats = useMemo(() => {
    const miles = runs.reduce((acc, run) => acc + Number(run.distance || 0), 0);
    return {
      totalRuns: runs.length,
      totalMiles: miles.toFixed(1),
      totalWorkouts: workouts.length
    };
  }, [runs, workouts]);

  const handleHealthConnect = async () => {
    if (Platform.OS !== 'ios') {
      Alert.alert('Not Available', 'Apple Health integration is available on iOS only.');
      return;
    }

    try {
      await requestPermissions();
      Alert.alert('Connected', 'Apple Health permissions granted.');
    } catch (error) {
      Alert.alert('Connection Failed', error?.message || 'Unable to connect to Apple Health.');
    }
  };

  return (
    <ScrollView className="flex-1 bg-forge-bg px-4 pt-6">
      <Text className="text-2xl font-bold text-forge-text">Profile</Text>
      <Text className="mt-1 text-forge-subtext">Training summary and integrations.</Text>

      <View className="mt-5 rounded-2xl border border-forge-border bg-forge-card p-4">
        <View className="flex-row items-center gap-2">
          <Activity size={18} color="#EAB308" />
          <Text className="text-base font-semibold text-forge-text">Stats</Text>
        </View>
        <View className="mt-4 gap-2">
          <Text className="text-forge-subtext">Total Runs: <Text className="text-forge-text">{stats.totalRuns}</Text></Text>
          <Text className="text-forge-subtext">Total Miles: <Text className="text-forge-text">{stats.totalMiles}</Text></Text>
          <Text className="text-forge-subtext">Total Workouts: <Text className="text-forge-text">{stats.totalWorkouts}</Text></Text>
        </View>
      </View>

      <Pressable onPress={handleHealthConnect} className="mt-4 flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-4 py-3">
        <ShieldCheck size={18} color="#EAB308" />
        <Text className="font-semibold text-forge-text">Connect Apple Health</Text>
      </Pressable>

      <Pressable
        onPress={() => navigation.navigate('GarminSync')}
        className="mt-3 flex-row items-center justify-between rounded-xl border border-forge-border bg-forge-card px-4 py-3"
      >
        <View className="flex-row items-center gap-2">
          <Link2 size={18} color="#EAB308" />
          <Text className="font-semibold text-forge-text">Garmin Connect</Text>
        </View>
        <View className="flex-row items-center gap-2">
          <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: garminConnected ? '#22c55e' : '#64748b' }} />
          <Text className="text-sm text-forge-subtext">{garminConnected ? 'Connected' : 'Not connected'}</Text>
          <ChevronRight size={16} color="#94a3b8" />
        </View>
      </Pressable>

      <Pressable onPress={signOut} className="mt-3 mb-8 flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3">
        <LogOut size={18} color="#0f1117" />
        <Text className="font-semibold text-black">Logout</Text>
      </Pressable>
    </ScrollView>
  );
}
