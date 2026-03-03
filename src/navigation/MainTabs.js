import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  Activity,
  Clock3,
  Dumbbell,
  LayoutDashboard,
  Trophy,
  User,
  Users
} from 'lucide-react-native';

import Dashboard from '../screens/Dashboard';
import RunHub from '../screens/RunHub';
import LogLift from '../screens/LogLift';
import Challenges from '../screens/Challenges';
import Community from '../screens/Community';
import History from '../screens/History';
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
          backgroundColor: '#0f1117',
          borderTopColor: '#2c3345',
          borderTopWidth: 1,
          paddingTop: 8,
        },
        tabBarActiveTintColor: '#EAB308',
        tabBarInactiveTintColor: '#64748b',
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600'
        }
      }}
    >
      <Tab.Screen
        name="Home"
        component={Dashboard}
        options={{
          tabBarIcon: ({ color }) => <LayoutDashboard color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Run"
        component={RunHub}
        options={{
          tabBarIcon: ({ color }) => <Activity color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Lift"
        component={LogLift}
        options={{
          tabBarIcon: ({ color }) => <Dumbbell color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Challenges"
        component={Challenges}
        options={{
          tabBarIcon: ({ color }) => <Trophy color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="Community"
        component={Community}
        options={{
          tabBarIcon: ({ color }) => <Users color={color} {...iconProps} />
        }}
      />
      <Tab.Screen
        name="History"
        component={History}
        options={{
          tabBarIcon: ({ color }) => <Clock3 color={color} {...iconProps} />
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
