import React, { useContext, useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, Image } from 'react-native';
import { ArrowRight } from 'lucide-react-native';

import api from '../lib/api';
import { AuthContext } from '../navigation/AppNavigator';

export default function Login({ navigation }) {
  const { signIn } = useContext(AuthContext);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async () => {
    if (!email || !password) {
      Alert.alert('Missing Fields', 'Email and password are required.');
      return;
    }
    try {
      setLoading(true);
      const response = await api.post('/auth/login', { email, password });
      const token = response?.data?.token;
      if (!token) throw new Error('No auth token returned');
      await signIn(token);
    } catch (error) {
      Alert.alert('Login Failed', error?.response?.data?.message || 'Invalid credentials.');
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
          <Text style={styles.tagline}>Sign in to continue training.</Text>
        </View>

        {/* Inputs */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Email</Text>
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

        {/* Sign In Button */}
        <Pressable
          onPress={handleLogin}
          disabled={loading}
          style={({ pressed }) => [styles.button, pressed && { opacity: 0.85 }]}
        >
          <Text style={styles.buttonText}>{loading ? 'Signing In...' : 'Sign In'}</Text>
          {!loading && <ArrowRight color="#0f1117" size={18} />}
        </Pressable>

        {/* Register Link */}
        <Pressable onPress={() => navigation.navigate('Register')} style={styles.registerLink}>
          <Text style={styles.registerText}>
            No account? <Text style={styles.registerAccent}>Create one</Text>
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
  registerLink: {
    paddingVertical: 8,
    alignItems: 'center',
  },
  registerText: {
    color: '#94a3b8',
    fontSize: 14,
  },
  registerAccent: {
    color: '#EAB308',
    fontWeight: '600',
  },
});
