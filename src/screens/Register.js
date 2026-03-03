import React, { useContext, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, Image } from 'react-native';
import { ArrowRight } from 'lucide-react-native';

import api from '../lib/api';
import { AuthContext } from '../context/AuthContext';

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
      if (!token) throw new Error('No auth token returned');
      await signIn(token);
    } catch (error) {
      Alert.alert('Registration Failed', error?.response?.data?.message || 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.container}
    >
      <View style={styles.inner}>
        {/* Logo */}
        <View style={styles.logoWrapper}>
          <Image
            source={require('../../assets/icon.png')}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.appName}>FORGE</Text>
          <Text style={styles.tagline}>Create your account.</Text>
        </View>

        {/* Inputs */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Name</Text>
          <TextInput
            style={styles.input}
            placeholder="Your name"
            placeholderTextColor="#64748b"
            autoCapitalize="words"
            value={name}
            onChangeText={setName}
          />
          <Text style={[styles.label, { marginTop: 12 }]}>Email</Text>
          <TextInput
            style={styles.input}
            placeholder="you@example.com"
            placeholderTextColor="#64748b"
            autoCapitalize="none"
            keyboardType="email-address"
            value={email}
            onChangeText={setEmail}
          />
          <Text style={[styles.label, { marginTop: 12 }]}>Password</Text>
          <TextInput
            style={styles.input}
            placeholder="••••••••"
            placeholderTextColor="#64748b"
            secureTextEntry
            value={password}
            onChangeText={setPassword}
          />
        </View>

        {/* Create Account Button */}
        <Pressable
          onPress={handleRegister}
          disabled={loading}
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.buttonText}>{loading ? 'Creating Account...' : 'Create Account'}</Text>
          {!loading && <ArrowRight color="#0f1117" size={18} />}
        </Pressable>

        {/* Login Link */}
        <Pressable onPress={() => navigation.navigate('Login')} style={styles.loginLink}>
          <Text style={styles.loginText}>
            Already have an account? <Text style={styles.loginAccent}>Sign in</Text>
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f1117',
    paddingHorizontal: 24,
  },
  inner: {
    flex: 1,
    justifyContent: 'center',
    gap: 24,
  },
  logoWrapper: {
    alignItems: 'center',
    marginBottom: 8,
  },
  logo: {
    width: 100,
    height: 100,
    marginBottom: 16,
  },
  appName: {
    fontSize: 36,
    fontWeight: 'bold',
    color: '#EAB308',
    letterSpacing: 4,
    marginBottom: 8,
  },
  tagline: {
    fontSize: 15,
    color: '#94a3b8',
  },
  inputGroup: {
    gap: 4,
  },
  label: {
    fontSize: 13,
    color: '#94a3b8',
    marginBottom: 4,
    fontWeight: '500',
  },
  input: {
    backgroundColor: '#171c27',
    borderWidth: 1,
    borderColor: '#2c3345',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: '#ffffff',
    fontSize: 16,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#EAB308',
    borderRadius: 12,
    paddingVertical: 16,
    marginTop: 4,
  },
  buttonText: {
    color: '#0f1117',
    fontWeight: 'bold',
    fontSize: 16,
  },
  loginLink: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  loginText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  loginAccent: {
    color: '#EAB308',
    fontWeight: '600',
  },
});
