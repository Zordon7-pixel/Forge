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

export default function ForgotPassword({ navigation }) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!email.trim()) {
      Alert.alert('Missing Email', 'Enter your account email.');
      return;
    }

    try {
      setLoading(true);
      await api.post('/auth/forgot-password', { email: email.trim() });
      Alert.alert('Request Sent', 'If the email exists, password reset instructions were sent.');
      navigation.navigate('ResetPassword');
    } catch (error) {
      Alert.alert('Request Failed', error?.response?.data?.error || 'Could not start password reset.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.title}>Forgot Password</Text>
        <Text style={styles.subtitle}>Enter your email to request a reset token.</Text>

        <TextInput
          value={email}
          onChangeText={setEmail}
          style={styles.input}
          placeholder="you@example.com"
          placeholderTextColor={COLORS.subtext}
          keyboardType="email-address"
          autoCapitalize="none"
        />

        <Pressable onPress={submit} disabled={loading} style={[styles.button, loading && styles.disabled]}>
          <Text style={styles.buttonText}>{loading ? 'Sending...' : 'Send Reset Link'}</Text>
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
