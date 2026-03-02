import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ActivitySquare, Database } from 'lucide-react-native';

import api from '../lib/api';
import useHealthData from '../hooks/useHealthData';

export default function History() {
  const [source, setSource] = useState('forge');
  const [tab, setTab] = useState('runs');
  const [runs, setRuns] = useState([]);
  const [workouts, setWorkouts] = useState([]);
  const [refreshing, setRefreshing] = useState(false);
  const {
    workouts: healthWorkouts,
    loading: healthLoading,
    error: healthError,
    refresh: refreshHealth
  } = useHealthData();

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
      refreshHealth();
    }, [loadData, refreshHealth])
  );

  const refreshAll = useCallback(async () => {
    await Promise.all([loadData(), refreshHealth()]);
  }, [loadData, refreshHealth]);

  const healthRuns = healthWorkouts.filter((workout) => workout.type === 'run');
  const healthLifts = healthWorkouts.filter((workout) => workout.type === 'strength');

  return (
    <ScrollView
      className="flex-1 bg-forge-bg px-4 pt-6"
      refreshControl={
        <RefreshControl tintColor="#EAB308" refreshing={refreshing || healthLoading} onRefresh={refreshAll} />
      }
    >
      <Text className="text-2xl font-bold text-forge-text">History</Text>
      <Text className="mt-1 text-forge-subtext">Review logged training sessions.</Text>

      <View className="mt-5 flex-row rounded-xl border border-forge-border bg-forge-card p-1">
        <Pressable
          onPress={() => setSource('forge')}
          className={`flex-1 flex-row items-center justify-center gap-2 rounded-lg py-2 ${source === 'forge' ? 'bg-forge-accent' : ''}`}
        >
          <Database size={14} color={source === 'forge' ? '#0f1117' : '#94a3b8'} />
          <Text className={`text-center font-medium ${source === 'forge' ? 'text-black' : 'text-forge-subtext'}`}>FORGE</Text>
        </Pressable>
        <Pressable
          onPress={() => setSource('health')}
          className={`flex-1 flex-row items-center justify-center gap-2 rounded-lg py-2 ${source === 'health' ? 'bg-forge-accent' : ''}`}
        >
          <ActivitySquare size={14} color={source === 'health' ? '#0f1117' : '#94a3b8'} />
          <Text className={`text-center font-medium ${source === 'health' ? 'text-black' : 'text-forge-subtext'}`}>Health</Text>
        </Pressable>
      </View>

      <View className="mt-5 flex-row rounded-xl border border-forge-border bg-forge-card p-1">
        <Pressable onPress={() => setTab('runs')} className={`flex-1 rounded-lg py-2 ${tab === 'runs' ? 'bg-forge-accent' : ''}`}>
          <Text className={`text-center font-medium ${tab === 'runs' ? 'text-black' : 'text-forge-subtext'}`}>Runs</Text>
        </Pressable>
        <Pressable onPress={() => setTab('lifts')} className={`flex-1 rounded-lg py-2 ${tab === 'lifts' ? 'bg-forge-accent' : ''}`}>
          <Text className={`text-center font-medium ${tab === 'lifts' ? 'text-black' : 'text-forge-subtext'}`}>Lifts</Text>
        </Pressable>
      </View>

      <View className="mt-4 gap-3 pb-8">
        {source === 'forge' && tab === 'runs' && runs.map((run, index) => (
          <View key={`run-${run.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">{Number(run.distance || 0).toFixed(2)} miles</Text>
            <Text className="mt-1 text-sm text-forge-subtext">
              {Math.floor(Number(run.duration || 0) / 60)} min · {run.pace || 'N/A'} pace
            </Text>
          </View>
        ))}
        {source === 'forge' && tab === 'lifts' && workouts.map((workout, index) => (
          <View key={`workout-${workout.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">{workout.name || 'Lift Session'}</Text>
            <Text className="mt-1 text-sm text-forge-subtext">{(workout.sets || []).length} sets</Text>
          </View>
        ))}

        {source === 'health' && tab === 'runs' && healthRuns.map((workout, index) => (
          <View key={`health-run-${workout.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">{workout.title || 'Run'}</Text>
            <Text className="mt-1 text-sm text-forge-subtext">
              {Math.floor(Number(workout.duration || 0) / 60)} min
              {workout.distanceMiles ? ` · ${Number(workout.distanceMiles).toFixed(2)} mi` : ''}
            </Text>
          </View>
        ))}
        {source === 'health' && tab === 'lifts' && healthLifts.map((workout, index) => (
          <View key={`health-lift-${workout.id || index}`} className="rounded-xl border border-forge-border bg-forge-card p-4">
            <Text className="font-medium text-forge-text">{workout.title || 'Strength Training'}</Text>
            <Text className="mt-1 text-sm text-forge-subtext">{Math.floor(Number(workout.duration || 0) / 60)} min</Text>
          </View>
        ))}

        {source === 'forge' && tab === 'runs' && !runs.length && <Text className="text-center text-forge-subtext">No runs found.</Text>}
        {source === 'forge' && tab === 'lifts' && !workouts.length && <Text className="text-center text-forge-subtext">No workouts found.</Text>}
        {source === 'health' && tab === 'runs' && !healthRuns.length && <Text className="text-center text-forge-subtext">No health runs found.</Text>}
        {source === 'health' && tab === 'lifts' && !healthLifts.length && <Text className="text-center text-forge-subtext">No health strength sessions found.</Text>}
        {source === 'health' && !!healthError && <Text className="text-center text-forge-subtext">Health data unavailable. Check permissions in Settings.</Text>}
      </View>
    </ScrollView>
  );
}
