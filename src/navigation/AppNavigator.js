import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import MainTabs from './MainTabs';
import Login from '../screens/Login';
import Register from '../screens/Register';
import ForgotPassword from '../screens/ForgotPassword';
import ResetPassword from '../screens/ResetPassword';
import LogRun from '../screens/LogRun';
import LogLift from '../screens/LogLift';
import GarminSync from '../screens/GarminSync';
import Settings from '../screens/Settings';
import Journal from '../screens/Journal';
import Profile from '../screens/Profile';
import Warmup from '../screens/Warmup';
import Onboarding from '../screens/Onboarding';
import Plan from '../screens/Plan';
import DailyCheckIn from '../screens/DailyCheckIn';
import ActiveWorkout from '../screens/ActiveWorkout';
import WorkoutSummary from '../screens/WorkoutSummary';
import Injury from '../screens/Injury';
import Races from '../screens/Races';
import { clearToken, getToken, setToken } from '../lib/storage';
import { AuthContext } from '../context/AuthContext';
import api from '../lib/api';

const Stack = createStackNavigator();

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: '#0f1117',
    card: '#171c27',
    border: '#2c3345',
    text: '#FFFFFF',
    primary: '#EAB308'
  }
};

export default function AppNavigator() {
  const [token, setAuthToken] = useState(null);
  const [user, setUser] = useState(null);
  const [onboardingComplete, setOnboardingComplete] = useState(false);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const isOnboardingComplete = useCallback((nextUser) => {
    if (!nextUser || typeof nextUser !== 'object') return false;

    if (nextUser.onboarding_complete !== undefined) return Boolean(nextUser.onboarding_complete);
    if (nextUser.onboarded !== undefined) return Boolean(nextUser.onboarded);
    if (nextUser.profile_completed !== undefined) return Boolean(nextUser.profile_completed);

    return Boolean(nextUser.age && (nextUser.primary_goal || (Array.isArray(nextUser.goals) && nextUser.goals.length > 0)));
  }, []);

  const refreshUser = useCallback(async () => {
    if (!token) {
      setUser(null);
      setOnboardingComplete(false);
      return;
    }

    setProfileLoading(true);
    try {
      const response = await api.get('/auth/me').catch(() => ({ data: {} }));
      const nextUser = response?.data?.user || response?.data || {};
      setUser(nextUser);
      setOnboardingComplete(isOnboardingComplete(nextUser));
    } finally {
      setProfileLoading(false);
    }
  }, [token, isOnboardingComplete]);

  useEffect(() => {
    const bootstrap = async () => {
      const stored = await getToken();
      setAuthToken(stored);
      setLoading(false);
    };

    bootstrap();
  }, []);

  const signIn = useCallback(async (nextToken) => {
    await setToken(nextToken);
    setAuthToken(nextToken);
  }, []);

  const signOut = useCallback(async () => {
    await clearToken();
    setAuthToken(null);
    setUser(null);
    setOnboardingComplete(false);
  }, []);

  const authValue = useMemo(
    () => ({ token, user, onboardingComplete, signIn, signOut, refreshUser }),
    [token, user, onboardingComplete, signIn, signOut, refreshUser]
  );

  useEffect(() => {
    refreshUser();
  }, [refreshUser]);

  if (loading || (token && profileLoading)) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color="#EAB308" size="large" />
      </View>
    );
  }

  return (
    <AuthContext.Provider value={authValue}>
      <NavigationContainer theme={theme}>
        <Stack.Navigator
          screenOptions={{
            headerStyle: { backgroundColor: '#171c27' },
            headerTintColor: '#FFFFFF',
            headerTitleStyle: { fontWeight: '600' },
            cardStyle: { backgroundColor: '#0f1117' }
          }}
        >
          {token ? (
            <>
              {!onboardingComplete ? (
                <Stack.Screen name="Onboarding" component={Onboarding} options={{ headerShown: false }} />
              ) : (
                <>
                  <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
                  <Stack.Screen name="LogRun" component={LogRun} options={{ title: 'Log Run' }} />
                  <Stack.Screen name="LogLift" component={LogLift} options={{ title: 'Log Lift' }} />
                  <Stack.Screen name="GarminSync" component={GarminSync} options={{ title: 'Garmin Connect' }} />
                  <Stack.Screen name="Settings" component={Settings} options={{ title: 'Settings' }} />
                  <Stack.Screen name="Journal" component={Journal} options={{ title: 'Journal' }} />
                  <Stack.Screen name="Profile" component={Profile} options={{ title: 'Profile' }} />
                  <Stack.Screen name="Warmup" component={Warmup} options={{ title: 'Warmup' }} />
                  <Stack.Screen name="Plan" component={Plan} options={{ title: 'Plan' }} />
                  <Stack.Screen name="DailyCheckIn" component={DailyCheckIn} options={{ title: 'Daily Check-In' }} />
                  <Stack.Screen name="ActiveWorkout" component={ActiveWorkout} options={{ title: 'Active Workout' }} />
                  <Stack.Screen name="WorkoutSummary" component={WorkoutSummary} options={{ title: 'Workout Summary' }} />
                  <Stack.Screen name="Injury" component={Injury} options={{ title: 'Injury Tracking' }} />
                  <Stack.Screen name="Races" component={Races} options={{ title: 'Races' }} />
                </>
              )}
            </>
          ) : (
            <>
              <Stack.Screen name="Login" component={Login} options={{ headerShown: false }} />
              <Stack.Screen name="Register" component={Register} options={{ headerShown: false }} />
              <Stack.Screen name="ForgotPassword" component={ForgotPassword} options={{ headerShown: false }} />
              <Stack.Screen name="ResetPassword" component={ResetPassword} options={{ headerShown: false }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </AuthContext.Provider>
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0f1117'
  }
});
