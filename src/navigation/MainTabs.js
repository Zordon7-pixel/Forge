import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Calendar, Home, Plus, User } from 'lucide-react-native';

import Dashboard from '../screens/Dashboard';
import History from '../screens/History';
import LogRun from '../screens/LogRun';
import Profile from '../screens/Profile';

const Tab = createBottomTabNavigator();

const iconProps = {
  size: 20,
  strokeWidth: 2.25
};

export default function MainTabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#171c27',
          borderTopColor: '#2c3345',
          height: 64,
          paddingTop: 8,
          paddingBottom: 8
        },
        tabBarActiveTintColor: '#EAB308',
        tabBarInactiveTintColor: '#94a3b8'
      }}
    >
      <Tab.Screen
        name="Dashboard"
        component={Dashboard}
        options={{
          tabBarIcon: ({ color }) => <Home color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Log"
        component={LogRun}
        options={{
          tabBarIcon: ({ color }) => <Plus color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="History"
        component={History}
        options={{
          tabBarIcon: ({ color }) => <Calendar color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Profile"
        component={Profile}
        options={{
          tabBarIcon: ({ color }) => <User color={color} {...iconProps} />
        }}
      />
    </Tab.Navigator>
  );
}
