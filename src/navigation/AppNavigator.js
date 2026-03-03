import React, { createContext, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import { createStackNavigator } from '@react-navigation/stack';

import MainTabs from './MainTabs';
import Login from '../screens/Login';
import Register from '../screens/Register';
import LogRun from '../screens/LogRun';
import LogLift from '../screens/LogLift';
import GarminSync from '../screens/GarminSync';
import { clearToken, getToken, setToken } from '../lib/storage';

const Stack = createStackNavigator();

export const AuthContext = createContext({
  token: null,
  signIn: async () => {},
  signOut: async () => {}
});

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
  const [loading, setLoading] = useState(true);

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
  }, []);

  const authValue = useMemo(
    () => ({ token, signIn, signOut }),
    [token, signIn, signOut]
  );

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-forge-bg">
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
              <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />
              <Stack.Screen name="LogRun" component={LogRun} options={{ title: 'Log Run' }} />
              <Stack.Screen name="LogLift" component={LogLift} options={{ title: 'Log Lift' }} />
              <Stack.Screen name="GarminSync" component={GarminSync} options={{ title: 'Garmin Connect' }} />
            </>
          ) : (
            <>
              <Stack.Screen name="Login" component={Login} options={{ headerShown: false }} />
              <Stack.Screen name="Register" component={Register} options={{ headerShown: false }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
    </AuthContext.Provider>
  );
}
