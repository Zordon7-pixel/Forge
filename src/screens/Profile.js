import React, { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Activity, ChevronRight, Link2, LogOut, ShieldCheck } from 'lucide-react-native';

import api from '../lib/api';
import { requestPermissions } from '../lib/health';
import { AuthContext } from '../navigation/AppNavigator';
import { isConnected as isGarminConnected } from '../services/GarminConnect';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
  error: '#ef4444'
};

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
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Profile</Text>
      <Text style={styles.subtitle}>Training summary and integrations.</Text>

      <View style={styles.card}>
        <View style={styles.rowStart}>
          <Activity size={18} color={COLORS.accent} />
          <Text style={styles.cardTitle}>Stats</Text>
        </View>
        <View style={styles.statRows}>
          <Text style={styles.statText}>
            Total Runs: <Text style={styles.statValue}>{stats.totalRuns}</Text>
          </Text>
          <Text style={styles.statText}>
            Total Miles: <Text style={styles.statValue}>{stats.totalMiles}</Text>
          </Text>
          <Text style={styles.statText}>
            Total Workouts: <Text style={styles.statValue}>{stats.totalWorkouts}</Text>
          </Text>
        </View>
      </View>

      <Pressable onPress={handleHealthConnect} style={styles.secondaryButton}>
        <ShieldCheck size={18} color={COLORS.accent} />
        <Text style={styles.secondaryButtonText}>Connect Apple Health</Text>
      </Pressable>

      <Pressable onPress={() => navigation.navigate('GarminSync')} style={styles.garminButton}>
        <View style={styles.rowStart}>
          <Link2 size={18} color={COLORS.accent} />
          <Text style={styles.secondaryButtonText}>Garmin Connect</Text>
        </View>
        <View style={styles.rowStart}>
          <View style={[styles.statusDot, { backgroundColor: garminConnected ? COLORS.success : COLORS.subtext }]} />
          <Text style={styles.garminStatus}>{garminConnected ? 'Connected' : 'Not connected'}</Text>
          <ChevronRight size={16} color={COLORS.subtext} />
        </View>
      </Pressable>

      <Pressable onPress={signOut} style={styles.primaryButton}>
        <LogOut size={18} color={COLORS.background} />
        <Text style={styles.primaryButtonText}>Logout</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 32
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700'
  },
  subtitle: {
    color: COLORS.subtext,
    marginTop: 4,
    fontSize: 15
  },
  card: {
    marginTop: 16,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16
  },
  rowStart: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 8
  },
  statRows: {
    marginTop: 12
  },
  statText: {
    color: COLORS.subtext,
    marginTop: 6,
    fontSize: 14
  },
  statValue: {
    color: COLORS.text,
    fontWeight: '600'
  },
  secondaryButton: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600',
    marginLeft: 8,
    fontSize: 15
  },
  garminButton: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingVertical: 14,
    paddingHorizontal: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 7
  },
  garminStatus: {
    color: COLORS.subtext,
    fontSize: 13,
    marginRight: 7
  },
  primaryButton: {
    marginTop: 10,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  primaryButtonText: {
    color: COLORS.background,
    fontWeight: '700',
    marginLeft: 8,
    fontSize: 15
  }
});
