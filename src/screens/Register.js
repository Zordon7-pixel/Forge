import React, { useContext, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, Text, TextInput, View } from 'react-native';
import { ArrowRight, UserPlus } from 'lucide-react-native';

import api from '../lib/api';
import { AuthContext } from '../navigation/AppNavigator';

export default function Register({ navigation }) {
  const { signIn } = useContext(AuthContext);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleRegister = async () => {
    if (!name || !email || !password) {
      Alert.alert('Missing Fields', 'Name, email, and password are required.');
      return;
    }

    try {
      setLoading(true);
      const response = await api.post('/auth/register', { name, email, password });
      const token = response?.data?.token;

      if (!token) {
        throw new Error('No auth token returned');
      }

      await signIn(token);
    } catch (error) {
      Alert.alert('Registration Failed', error?.response?.data?.message || 'Unable to create account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      className="flex-1 bg-forge-bg px-6"
    >
      <View className="flex-1 justify-center gap-5">
        <View className="gap-3">
          <View className="h-12 w-12 items-center justify-center rounded-xl bg-forge-card border border-forge-border">
            <UserPlus color="#EAB308" size={22} />
          </View>
          <Text className="text-3xl font-bold text-forge-text">Create Account</Text>
          <Text className="text-base text-forge-subtext">Start building your performance log.</Text>
        </View>

        <View className="gap-3">
          <TextInput
            className="rounded-xl border border-forge-border bg-forge-card px-4 py-3 text-forge-text"
            placeholder="Name"
            placeholderTextColor="#64748b"
            value={name}
            onChangeText={setName}
          />
          <TextInput
            className="rounded-xl border border-forge-border bg-forge-card px-4 py-3 text-forge-text"
            placeholder="Email"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            className="rounded-xl border border-forge-border bg-forge-card px-4 py-3 text-forge-text"
            placeholder="Password"
            placeholderTextColor="#64748b"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </View>

        <Pressable
          onPress={handleRegister}
          disabled={loading}
          className="flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3"
        >
          <Text className="font-semibold text-black">{loading ? 'Creating...' : 'Create Account'}</Text>
          {!loading && <ArrowRight color="#0f1117" size={18} />}
        </Pressable>

        <Pressable onPress={() => navigation.navigate('Login')} className="py-2">
          <Text className="text-center text-forge-subtext">
            Already registered? <Text className="text-forge-accent">Sign in</Text>
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}
