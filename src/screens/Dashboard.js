import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ArrowRight, Dumbbell, Route } from 'lucide-react-native';

import api from '../lib/api';

export default function Dashboard({ navigation }) {
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadDashboard = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, liftsRes] = await Promise.all([
        api.get('/runs?limit=5'),
        api.get('/workouts?limit=5')
      ]);

      setRuns(runsRes?.data?.runs || runsRes?.data || []);
      setWorkouts(liftsRes?.data?.workouts || liftsRes?.data || []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadDashboard();
    }, [loadDashboard])
  );

  const weekStats = useMemo(() => {
    const miles = runs.reduce((acc, run) => acc + Number(run.distance || 0), 0);
    const liftSessions = workouts.length;
    return {
      miles: miles.toFixed(1),
      runs: runs.length,
      lifts: liftSessions
    };
  }, [runs, workouts]);

  return (
    <ScrollView
      className="flex-1 bg-forge-bg px-4 pt-6"
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={loadDashboard} />}
    >
      <Text className="text-2xl font-bold text-forge-text">Dashboard</Text>
      <Text className="mt-1 text-forge-subtext">Performance snapshot for this week.</Text>

      <View className="mt-5 rounded-2xl border border-forge-border bg-forge-card p-4">
        <Text className="text-sm text-forge-subtext">Weekly Stats</Text>
        <View className="mt-4 flex-row justify-between">
          <View>
            <Text className="text-2xl font-semibold text-forge-accent">{weekStats.miles}</Text>
            <Text className="text-xs text-forge-subtext">Miles</Text>
          </View>
          <View>
            <Text className="text-2xl font-semibold text-forge-accent">{weekStats.runs}</Text>
            <Text className="text-xs text-forge-subtext">Runs</Text>
          </View>
          <View>
            <Text className="text-2xl font-semibold text-forge-accent">{weekStats.lifts}</Text>
            <Text className="text-xs text-forge-subtext">Lifts</Text>
          </View>
        </View>
      </View>

      <View className="mt-5 flex-row gap-3">
        <Pressable
          onPress={() => navigation.navigate('LogRun')}
          className="flex-1 flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-3 py-3"
        >
          <Route size={18} color="#0f1117" />
          <Text className="font-semibold text-black">Log Run</Text>
        </Pressable>
        <Pressable
          onPress={() => navigation.navigate('LogLift')}
          className="flex-1 flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-3 py-3"
        >
          <Dumbbell size={18} color="#EAB308" />
          <Text className="font-semibold text-forge-text">Log Lift</Text>
        </Pressable>
      </View>

      <Text className="mt-7 text-lg font-semibold text-forge-text">Recent Activity</Text>

      <View className="mt-3 gap-3 pb-8">
        {runs.map((run, index) => (
          <View key={`run-${run.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">Run</Text>
            <Text className="mt-1 text-sm text-forge-subtext">
              {Number(run.distance || 0).toFixed(2)} mi · {Math.floor(Number(run.duration || 0) / 60)} min
            </Text>
          </View>
        ))}
        {workouts.map((lift, index) => (
          <View key={`lift-${lift.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">{lift.name || 'Lift Session'}</Text>
            <Text className="mt-1 text-sm text-forge-subtext">{(lift.sets || []).length} sets recorded</Text>
          </View>
        ))}
        {!runs.length && !workouts.length && (
          <View className="items-center rounded-xl border border-dashed border-forge-border bg-forge-card p-6">
            <Text className="text-forge-subtext">No activity logged yet.</Text>
            <View className="mt-2">
              <ArrowRight size={18} color="#94a3b8" />
            </View>
          </View>
        )}
      </View>
    </ScrollView>
  );
}
