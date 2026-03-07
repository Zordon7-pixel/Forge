import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import api from '../lib/api';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433'
};

export default function ResetPassword({ navigation, route }) {
  const [token, setToken] = useState(route?.params?.token || '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!token.trim()) {
      Alert.alert('Missing Token', 'Provide the password reset token.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Weak Password', 'Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      Alert.alert('Mismatch', 'Passwords do not match.');
      return;
    }

    try {
      setLoading(true);
      await api.post('/auth/reset-password', { token: token.trim(), password });
      Alert.alert('Password Updated', 'You can now sign in with your new password.');
      navigation.navigate('Login');
    } catch (error) {
      Alert.alert('Reset Failed', error?.response?.data?.error || 'Reset failed. Token may be expired.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Set New Password</Text>
        <Text style={styles.subtitle}>Paste your reset token and choose a new password.</Text>

        <TextInput
          value={token}
          onChangeText={setToken}
          style={styles.input}
          placeholder="Reset token"
          placeholderTextColor={COLORS.subtext}
          autoCapitalize="none"
        />

        <TextInput
          value={password}
          onChangeText={setPassword}
          style={styles.input}
          placeholder="New password"
          placeholderTextColor={COLORS.subtext}
          secureTextEntry
        />

        <TextInput
          value={confirm}
          onChangeText={setConfirm}
          style={styles.input}
          placeholder="Confirm new password"
          placeholderTextColor={COLORS.subtext}
          secureTextEntry
        />

        <Pressable onPress={submit} disabled={loading} style={[styles.button, loading && styles.disabled]}>
          <Text style={styles.buttonText}>{loading ? 'Updating...' : 'Set New Password'}</Text>
        </Pressable>

        <Pressable onPress={() => navigation.navigate('Login')}>
          <Text style={styles.link}>Back to Sign In</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    paddingHorizontal: 20
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 18,
    gap: 12
  },
  title: {
    color: COLORS.text,
    fontSize: 26,
    fontWeight: '800'
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 14
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    backgroundColor: COLORS.input,
    color: COLORS.text,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 11
  },
  button: {
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    paddingVertical: 12
  },
  buttonText: {
    color: '#000',
    fontWeight: '800'
  },
  link: {
    color: COLORS.subtext,
    textAlign: 'center',
    marginTop: 2
  },
  disabled: {
    opacity: 0.6
  }
});
