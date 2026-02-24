import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';

import api from '../lib/api';

export default function History() {
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);

  const loadData = useCallback(async () => {
    setRefreshing(true);
    try {
      const [runsRes, workoutsRes] = await Promise.all([api.get('/runs'), api.get('/workouts')]);
      setRuns(runsRes?.data?.runs || runsRes?.data || []);
      setWorkouts(workoutsRes?.data?.workouts || workoutsRes?.data || []);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  return (
    <ScrollView
      className="flex-1 bg-forge-bg px-4 pt-6"
      refreshControl={<RefreshControl tintColor="#EAB308" refreshing={refreshing} onRefresh={loadData} />}
    >
      <Text className="text-2xl font-bold text-forge-text">History</Text>
      <Text className="mt-1 text-forge-subtext">Review logged training sessions.</Text>

      <View className="mt-5 flex-row rounded-xl border border-forge-border bg-forge-card p-1">
        <Pressable onPress={() => setTab('runs')} className={`flex-1 rounded-lg py-2 ${tab === 'runs' ? 'bg-forge-accent' : ''}`}>
          <Text className={`text-center font-medium ${tab === 'runs' ? 'text-black' : 'text-forge-subtext'}`}>Runs</Text>
        </Pressable>
        <Pressable onPress={() => setTab('lifts')} className={`flex-1 rounded-lg py-2 ${tab === 'lifts' ? 'bg-forge-accent' : ''}`}>
          <Text className={`text-center font-medium ${tab === 'lifts' ? 'text-black' : 'text-forge-subtext'}`}>Lifts</Text>
        </Pressable>
      </View>

      <View className="mt-4 gap-3 pb-8">
        {tab === 'runs'
          ? runs.map((run, index) => (
              <View key={`run-${run.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
                <Text className="font-medium text-forge-text">{Number(run.distance || 0).toFixed(2)} miles</Text>
                <Text className="mt-1 text-sm text-forge-subtext">
                  {Math.floor(Number(run.duration || 0) / 60)} min · {run.pace || 'N/A'} pace
                </Text>
              </View>
            ))
          : workouts.map((workout, index) => (
              <View key={`workout-${workout.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
                <Text className="font-medium text-forge-text">{workout.name || 'Lift Session'}</Text>
                <Text className="mt-1 text-sm text-forge-subtext">{(workout.sets || []).length} sets</Text>
              </View>
            ))}

        {tab === 'runs' && !runs.length && <Text className="text-center text-forge-subtext">No runs found.</Text>}
        {tab === 'lifts' && !workouts.length && <Text className="text-center text-forge-subtext">No workouts found.</Text>}
      </View>
    </ScrollView>
  );
}
