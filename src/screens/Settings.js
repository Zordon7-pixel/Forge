import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useContext, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ChevronRight, Link2, RefreshCw, Unplug, Watch } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';
import { AuthContext } from '../context/AuthContext';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433',
  error: '#ef4444',
  success: '#22c55e',
};

const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'pt-BR', name: 'Português (BR)' },
  { code: 'de', name: 'Deutsch' },
  { code: 'fr', name: 'Français' },
  { code: 'ja', name: '日本語' },
];

export default function Settings({ navigation }) {
  const insets = useSafeAreaInsets();
  const { logout } = useContext(AuthContext) || {};

  const [distanceUnit, setDistanceUnit] = useState('miles');
  const [language, setLanguage] = useState('en');
  const [saved, setSaved] = useState(false);

  // Garmin state
  const [garminStatus, setGarminStatus] = useState({ connected: false, lastSync: null, activityCount: 0, displayName: '' });
  const [garminUsername, setGarminUsername] = useState('');
  const [garminPassword, setGarminPassword] = useState('');
  const [garminLoading, setGarminLoading] = useState(false);
  const [garminSyncing, setGarminSyncing] = useState(false);
  const [garminNotice, setGarminNotice] = useState(null);

  const loadSettings = useCallback(async () => {
    try {
      const [settingsRes, garminRes] = await Promise.all([
        api.get('/users/settings').catch(() => ({ data: {} })),
        api.get('/garmin/status').catch(() => ({ data: {} })),
      ]);
      setDistanceUnit(settingsRes.data?.distance_unit || 'miles');
      setLanguage(settingsRes.data?.language || 'en');
      setGarminStatus({
        connected: Boolean(garminRes.data?.connected),
        lastSync: garminRes.data?.lastSync || null,
        activityCount: Number(garminRes.data?.activityCount || 0),
        displayName: garminRes.data?.displayName || '',
      });
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { loadSettings(); }, [loadSettings]));

  const saveUnit = async (unit) => {
    setDistanceUnit(unit);
    await api.put('/users/settings', { distance_unit: unit }).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const saveLang = async (code) => {
    setLanguage(code);
    await api.put('/users/settings', { language: code }).catch(() => {});
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const connectGarmin = async () => {
    if (!garminUsername || !garminPassword) {
      setGarminNotice({ ok: false, text: 'Enter your Garmin username and password.' });
      return;
    }
    setGarminLoading(true);
    try {
      await api.post('/garmin/connect', { username: garminUsername, password: garminPassword });
      setGarminPassword('');
      setGarminNotice({ ok: true, text: 'Garmin connected.' });
      await loadSettings();
    } catch (err) {
      setGarminNotice({ ok: false, text: err?.response?.data?.error || 'Connection failed. Check your credentials.' });
    } finally {
      setGarminLoading(false);
    }
  };

  const syncGarmin = async () => {
    setGarminSyncing(true);
    try {
      const res = await api.post('/garmin/sync');
      setGarminNotice({ ok: true, text: `Synced ${res.data?.imported || 0} new activities.` });
      await loadSettings();
    } catch {
      setGarminNotice({ ok: false, text: 'Sync failed. Try again.' });
    } finally {
      setGarminSyncing(false);
    }
  };

  const disconnectGarmin = () => {
    Alert.alert('Disconnect Garmin', 'Remove your Garmin account from FORGE?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Disconnect', style: 'destructive', onPress: async () => {
          await api.post('/garmin/disconnect').catch(() => {});
          setGarminStatus({ connected: false, lastSync: null, activityCount: 0, displayName: '' });
          setGarminNotice({ ok: true, text: 'Garmin disconnected.' });
        }
      }
    ]);
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Sign out of FORGE?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => logout?.() }
    ]);
  };

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
    >
      <AppHeader />

      <View style={styles.titleRow}>
        <Text style={styles.title}>Settings</Text>
        {saved && <Text style={styles.savedBadge}>Saved</Text>}
      </View>

      {/* Units */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Distance Unit</Text>
        <View style={styles.toggleRow}>
          {['miles', 'km'].map((unit) => (
            <Pressable
              key={unit}
              onPress={() => saveUnit(unit)}
              style={[styles.toggleBtn, distanceUnit === unit && styles.toggleBtnActive]}
            >
              <Text style={[styles.toggleText, distanceUnit === unit && styles.toggleTextActive]}>
                {unit === 'miles' ? 'Miles' : 'Kilometers'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Language */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Language</Text>
        <View style={styles.langGrid}>
          {LANGUAGES.map((lang) => (
            <Pressable
              key={lang.code}
              onPress={() => saveLang(lang.code)}
              style={[styles.langBtn, language === lang.code && styles.langBtnActive]}
            >
              <Text style={[styles.langText, language === lang.code && styles.langTextActive]}>
                {lang.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* Garmin */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Watch size={15} color={COLORS.accent} />
          <Text style={styles.sectionLabel}>Garmin Connect</Text>
        </View>

        {garminStatus.connected ? (
          <View style={styles.garminConnected}>
            <View style={styles.garminStatusRow}>
              <View style={styles.statusDot} />
              <Text style={styles.garminName}>{garminStatus.displayName || 'Connected'}</Text>
            </View>
            {garminStatus.lastSync && (
              <Text style={styles.garminMeta}>
                Last sync: {new Date(garminStatus.lastSync).toLocaleDateString()} · {garminStatus.activityCount} activities
              </Text>
            )}
            <View style={styles.garminActions}>
              <Pressable onPress={syncGarmin} style={styles.syncBtn} disabled={garminSyncing}>
                {garminSyncing
                  ? <ActivityIndicator size="small" color={COLORS.accent} />
                  : <><RefreshCw size={13} color={COLORS.accent} /><Text style={styles.syncBtnText}>Sync Now</Text></>
                }
              </Pressable>
              <Pressable onPress={disconnectGarmin} style={styles.disconnectBtn}>
                <Unplug size={13} color={COLORS.error} />
                <Text style={styles.disconnectBtnText}>Disconnect</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View>
            <TextInput
              style={styles.input}
              placeholder="Garmin username"
              placeholderTextColor={COLORS.subtext}
              value={garminUsername}
              onChangeText={setGarminUsername}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextInput
              style={[styles.input, { marginTop: 8 }]}
              placeholder="Garmin password"
              placeholderTextColor={COLORS.subtext}
              value={garminPassword}
              onChangeText={setGarminPassword}
              secureTextEntry
            />
            <Pressable onPress={connectGarmin} style={[styles.connectBtn, garminLoading && { opacity: 0.6 }]} disabled={garminLoading}>
              {garminLoading
                ? <ActivityIndicator size="small" color="#000" />
                : <><Link2 size={14} color="#000" /><Text style={styles.connectBtnText}>Connect Garmin</Text></>
              }
            </Pressable>
          </View>
        )}

        {garminNotice && (
          <Text style={[styles.notice, { color: garminNotice.ok ? COLORS.success : COLORS.error }]}>
            {garminNotice.text}
          </Text>
        )}
      </View>

      {/* Sign Out */}
      <Pressable onPress={handleLogout} style={styles.signOutBtn}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 48 },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  title: { color: COLORS.text, fontSize: 26, fontWeight: '800' },
  savedBadge: {
    backgroundColor: COLORS.success,
    color: '#000',
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 99,
  },
  section: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 14,
  },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionLabel: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 10,
  },
  toggleRow: { flexDirection: 'row', gap: 10 },
  toggleBtn: {
    flex: 1,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  toggleBtnActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  toggleText: { color: COLORS.subtext, fontSize: 13, fontWeight: '600' },
  toggleTextActive: { color: '#000' },
  langGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  langBtn: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  langBtnActive: { backgroundColor: COLORS.accent, borderColor: COLORS.accent },
  langText: { color: COLORS.subtext, fontSize: 12 },
  langTextActive: { color: '#000', fontWeight: '700' },
  garminConnected: {},
  garminStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: COLORS.success },
  garminName: { color: COLORS.text, fontSize: 13, fontWeight: '700' },
  garminMeta: { color: COLORS.subtext, fontSize: 12, marginBottom: 10 },
  garminActions: { flexDirection: 'row', gap: 10 },
  syncBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.accent,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  syncBtnText: { color: COLORS.accent, fontSize: 12, fontWeight: '700' },
  disconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  disconnectBtnText: { color: COLORS.error, fontSize: 12, fontWeight: '700' },
  input: {
    backgroundColor: COLORS.input,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: COLORS.text,
    fontSize: 14,
  },
  connectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    backgroundColor: COLORS.accent,
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 10,
  },
  connectBtnText: { color: '#000', fontWeight: '700', fontSize: 14 },
  notice: { fontSize: 12, marginTop: 8 },
  signOutBtn: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.error,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 6,
  },
  signOutText: { color: COLORS.error, fontSize: 14, fontWeight: '700' },
});
