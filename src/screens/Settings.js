import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useContext, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { ChevronRight, Link2, RefreshCw, Unplug, User, Watch } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';
import { AuthContext } from '../context/AuthContext';

// ─── Colors ───────────────────────────────────────────────────────────────────
const C = {
  bg:     '#0d1117',
  card:   '#161b22',
  accent: '#eab308',
  text:   '#ffffff',
  muted:  '#8b949e',
  border: '#21262d',
  input:  '#0d1117',
  green:  '#22c55e',
  red:    '#ef4444',
};

// ─── Language options (matches web) ───────────────────────────────────────────
const LANGUAGES = [
  { code: 'en',    name: 'English',         flag: '🇺🇸' },
  { code: 'es',    name: 'Español',          flag: '🇪🇸' },
  { code: 'pt-BR', name: 'Português (BR)',   flag: '🇧🇷' },
  { code: 'de',    name: 'Deutsch',          flag: '🇩🇪' },
  { code: 'fr',    name: 'Français',         flag: '🇫🇷' },
  { code: 'ja',    name: '日本語',            flag: '🇯🇵' },
];

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Settings({ navigation }) {
  const insets = useSafeAreaInsets();
  const { signOut } = useContext(AuthContext) || {};

  // Settings state
  const [units,    setUnits]    = useState('imperial');   // 'imperial' | 'metric'
  const [language, setLanguage] = useState('en');
  const [saved,    setSaved]    = useState(false);

  // Injury mode state
  const [injuryMode,        setInjuryMode]        = useState(false);
  const [injuryDescription, setInjuryDescription] = useState('');
  const [injurySaving,      setInjurySaving]       = useState(false);

  // Garmin state
  const [garminStatus,   setGarminStatus]   = useState({ connected: false, lastSync: null, activityCount: 0, displayName: '' });
  const [garminUsername, setGarminUsername] = useState('');
  const [garminPassword, setGarminPassword] = useState('');
  const [garminLoading,  setGarminLoading]  = useState(false);
  const [garminSyncing,  setGarminSyncing]  = useState(false);
  const [garminNotice,   setGarminNotice]   = useState(null);
  const [deletingAccount, setDeletingAccount] = useState(false);

  // ── Load ──
  const load = useCallback(async () => {
    try {
      const [settingsRes, garminRes, profileRes] = await Promise.all([
        api.get('/users/settings').catch(() => ({ data: {} })),
        api.get('/garmin/status').catch(() => ({ data: {} })),
        api.get('/auth/me').catch(() => ({ data: {} })),
      ]);
      setUnits(settingsRes.data?.units || settingsRes.data?.distance_unit === 'km' ? 'metric' : 'imperial');
      setLanguage(settingsRes.data?.language || 'en');
      setGarminStatus({
        connected:     Boolean(garminRes.data?.connected),
        lastSync:      garminRes.data?.lastSync || null,
        activityCount: Number(garminRes.data?.activityCount || 0),
        displayName:   garminRes.data?.displayName || '',
      });
      const user = profileRes.data?.user || {};
      setInjuryMode(Boolean(user.injury_mode));
      setInjuryDescription(user.injury_description || '');
    } catch {}
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  // ── Helpers ──
  const flash = () => { setSaved(true); setTimeout(() => setSaved(false), 2000); };

  const saveUnits = async (val) => {
    setUnits(val);
    await api.put('/users/settings', {
      units: val,
      distance_unit: val === 'imperial' ? 'miles' : 'km',
    }).catch(() => {});
    flash();
  };

  const saveLang = async (code) => {
    setLanguage(code);
    await api.put('/users/settings', { language: code }).catch(() => {});
    flash();
  };

  // ── Injury mode ──
  const toggleInjuryMode = async (value) => {
    setInjuryMode(value);
    if (!value) {
      setInjurySaving(true);
      await api.post('/auth/injury', { injury_mode: false, injury_description: '', injury_date: '', injury_limitations: '' }).catch(() => {});
      await api.delete('/injury/active').catch(async () => {
        await api.post('/injury/resolve').catch(() => {});
      });
      setInjurySaving(false);
      flash();
    }
  };

  const saveInjuryMode = async () => {
    setInjurySaving(true);
    try {
      await api.post('/auth/injury', {
        injury_mode: injuryMode,
        injury_description: injuryDescription,
        injury_date: new Date().toISOString().slice(0, 10),
        injury_limitations: '',
      });
      flash();
    } catch {}
    setInjurySaving(false);
  };

  // ── Garmin ──
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
      await load();
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
      setGarminNotice({ ok: true, text: `Synced ${res.data?.synced || res.data?.imported || 0} activities.` });
      await load();
    } catch {
      setGarminNotice({ ok: false, text: 'Sync failed. Try again.' });
    } finally {
      setGarminSyncing(false);
    }
  };

  const disconnectGarmin = () => {
    Alert.alert('Disconnect Garmin', 'Remove your Garmin account from FORGE?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Disconnect', style: 'destructive', onPress: async () => {
        await api.delete('/garmin/disconnect').catch(() => {});
        setGarminStatus({ connected: false, lastSync: null, activityCount: 0, displayName: '' });
        setGarminNotice({ ok: true, text: 'Garmin disconnected.' });
      }},
    ]);
  };

  const handleLogout = () => {
    Alert.alert('Sign Out', 'Sign out of FORGE?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign Out', style: 'destructive', onPress: () => signOut?.() },
    ]);
  };

  const handleDeleteAccount = () => {
    if (deletingAccount) return;
    Alert.alert(
      'Delete Account',
      'This will permanently delete your account and all data',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete Account',
          style: 'destructive',
          onPress: async () => {
            setDeletingAccount(true);
            try {
              await api.delete('/auth/account');
              signOut?.();
            } catch (error) {
              Alert.alert('Delete Failed', error?.response?.data?.error || 'Could not delete account.');
            } finally {
              setDeletingAccount(false);
            }
          }
        }
      ]
    );
  };

  const deleteButtonLabel = deletingAccount ? 'Deleting Account...' : 'Delete Account';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
    >
      <AppHeader />

      {/* Title row */}
      <View style={styles.titleRow}>
        <Text style={styles.title}>Settings</Text>
        {saved ? <View style={styles.savedBadge}><Text style={styles.savedText}>Saved ✓</Text></View> : null}
      </View>

      {/* ── Language ── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Language</Text>
        <View style={styles.langGrid}>
          {LANGUAGES.map((lang) => (
            <Pressable
              key={lang.code}
              onPress={() => saveLang(lang.code)}
              style={[styles.langBtn, language === lang.code && styles.langBtnActive]}
            >
              <Text style={styles.langFlag}>{lang.flag}</Text>
              <Text style={[styles.langText, language === lang.code && styles.langTextActive]}>
                {lang.name}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Units ── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Units</Text>
        <View style={styles.toggleRow}>
          {[['imperial', 'Imperial', 'Miles, lbs, °F'], ['metric', 'Metric', 'Km, kg, °C']].map(([val, label, sub]) => (
            <Pressable
              key={val}
              onPress={() => saveUnits(val)}
              style={[styles.unitBtn, units === val && styles.unitBtnActive]}
            >
              <Text style={[styles.unitLabel, units === val && styles.unitLabelActive]}>{label}</Text>
              <Text style={[styles.unitSub,   units === val && styles.unitSubActive]}>{sub}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {/* ── Account / Profile ── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Account</Text>

        <Pressable
          onPress={() => navigation.navigate('Profile')}
          style={styles.listRow}
        >
          <View style={styles.listRowLeft}>
            <User size={16} color={C.muted} />
            <Text style={styles.listRowText}>Edit Profile</Text>
          </View>
          <ChevronRight size={16} color={C.muted} />
        </Pressable>

        <View style={styles.divider} />

        <View style={styles.listRow}>
          <View style={styles.listRowLeft}>
            <Text style={styles.listRowText}>Notifications</Text>
          </View>
          <Text style={styles.comingSoon}>Coming soon</Text>
        </View>
      </View>

      {/* ── Injury Mode ── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Injury Mode</Text>
        <View style={styles.injuryToggleRow}>
          <View style={styles.injuryToggleLeft}>
            <Text style={styles.injuryToggleTitle}>Injury Mode</Text>
            <Text style={styles.injuryToggleSub}>
              Adjust plans for lower impact workouts while recovering
            </Text>
          </View>
          <Switch
            value={injuryMode}
            onValueChange={toggleInjuryMode}
            trackColor={{ false: C.border, true: C.accent }}
            thumbColor={injuryMode ? '#000' : C.muted}
          />
        </View>

        {injuryMode ? (
          <View style={styles.injuryDetails}>
            <TextInput
              style={styles.input}
              placeholder="Describe your injury (optional)"
              placeholderTextColor={C.muted}
              value={injuryDescription}
              onChangeText={setInjuryDescription}
              multiline
              numberOfLines={3}
            />
            <Pressable
              onPress={saveInjuryMode}
              style={[styles.saveBtn, injurySaving && { opacity: 0.6 }]}
              disabled={injurySaving}
            >
              {injurySaving
                ? <ActivityIndicator size="small" color="#000" />
                : <Text style={styles.saveBtnText}>Save Injury Mode</Text>}
            </Pressable>
          </View>
        ) : null}
      </View>

      {/* ── Garmin Connect ── */}
      <View style={[styles.section, styles.garminSection]}>
        <View style={styles.sectionHeader}>
          <Watch size={15} color={C.accent} />
          <Text style={[styles.sectionLabel, { marginBottom: 0, color: '#fcd34d' }]}>Garmin Connect</Text>
        </View>
        <Text style={styles.garminSub}>
          Connect Garmin to auto-sync activities from the last 30 days.
        </Text>

        {garminStatus.connected ? (
          <View>
            <View style={styles.garminStatusRow}>
              <View style={styles.statusDot} />
              <Text style={styles.garminName}>
                {garminStatus.displayName || 'Connected'}
              </Text>
            </View>
            {garminStatus.lastSync ? (
              <Text style={styles.garminMeta}>
                Last sync: {new Date(garminStatus.lastSync).toLocaleString()} · {garminStatus.activityCount} activities
              </Text>
            ) : null}
            <View style={styles.garminActions}>
              <Pressable onPress={syncGarmin} style={styles.syncBtn} disabled={garminSyncing}>
                {garminSyncing
                  ? <ActivityIndicator size="small" color={C.accent} />
                  : (
                    <>
                      <RefreshCw size={13} color={C.accent} />
                      <Text style={styles.syncBtnText}>Sync Now</Text>
                    </>
                  )}
              </Pressable>
              <Pressable onPress={disconnectGarmin} style={styles.disconnectBtn}>
                <Unplug size={13} color={C.red} />
                <Text style={styles.disconnectBtnText}>Disconnect</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <View>
            <View style={styles.garminInputWrap}>
              <User size={14} color="#fbbf24" style={styles.inputIcon} />
              <TextInput
                style={[styles.garminInput, styles.garminInputWithIcon]}
                placeholder="Garmin username"
                placeholderTextColor={C.muted}
                value={garminUsername}
                onChangeText={setGarminUsername}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
            <View style={[styles.garminInputWrap, { marginTop: 10 }]}>
              <Link2 size={14} color="#fbbf24" style={styles.inputIcon} />
              <TextInput
                style={[styles.garminInput, styles.garminInputWithIcon]}
                placeholder="Garmin password"
                placeholderTextColor={C.muted}
                value={garminPassword}
                onChangeText={setGarminPassword}
                secureTextEntry
              />
            </View>
            <Pressable
              onPress={connectGarmin}
              style={[styles.garminConnectBtn, garminLoading && { opacity: 0.6 }]}
              disabled={garminLoading}
            >
              {garminLoading
                ? <ActivityIndicator size="small" color="#000" />
                : (
                  <>
                    <Link2 size={14} color="#000" />
                    <Text style={styles.garminConnectText}>Connect Garmin</Text>
                  </>
                )}
            </Pressable>
          </View>
        )}

        {garminNotice ? (
          <Text style={[styles.notice, { color: garminNotice.ok ? C.green : C.red }]}>
            {garminNotice.text}
          </Text>
        ) : null}
      </View>

      {/* ── Data & Privacy ── */}
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>Data & Privacy</Text>
        <Text style={styles.privacyText}>
          Your data lives on FORGE servers. We never sell your information.
        </Text>
      </View>

      <Pressable onPress={handleLogout} style={styles.signOutBtn}>
        <Text style={styles.signOutText}>Sign Out</Text>
      </Pressable>

      <Pressable onPress={handleDeleteAccount} style={[styles.deleteAccountBtn, deletingAccount && styles.deleteAccountBtnDisabled]} disabled={deletingAccount}>
        <Text style={styles.deleteAccountText}>{deleteButtonLabel}</Text>
      </Pressable>

      <Text style={styles.versionText}>FORGE v1.0 · Built to adapt.</Text>
    </ScrollView>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content:   { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 48 },

  titleRow:   { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 },
  title:      { color: C.text, fontSize: 26, fontWeight: '800' },
  savedBadge: { backgroundColor: C.green, borderRadius: 99, paddingHorizontal: 10, paddingVertical: 4 },
  savedText:  { color: '#000', fontSize: 11, fontWeight: '700' },

  section:     { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 14, padding: 14, marginBottom: 14 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionLabel:  { color: C.text, fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },

  // Language grid
  langGrid:       { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  langBtn:        { flexDirection: 'row', alignItems: 'center', gap: 8, width: '47%', backgroundColor: C.input, borderWidth: 2, borderColor: C.border, borderRadius: 12, padding: 12 },
  langBtnActive:  { borderColor: C.accent, backgroundColor: 'rgba(234,179,8,0.12)' },
  langFlag:       { fontSize: 18 },
  langText:       { color: C.muted, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  langTextActive: { color: C.text, fontWeight: '700' },

  // Units
  toggleRow:       { flexDirection: 'row', gap: 10 },
  unitBtn:         { flex: 1, backgroundColor: C.input, borderWidth: 2, borderColor: C.border, borderRadius: 12, padding: 14, alignItems: 'center' },
  unitBtnActive:   { borderColor: C.accent, backgroundColor: 'rgba(234,179,8,0.12)' },
  unitLabel:       { color: C.muted, fontSize: 14, fontWeight: '700' },
  unitLabelActive: { color: C.accent },
  unitSub:         { color: C.muted, fontSize: 11, marginTop: 2 },
  unitSubActive:   { color: C.muted },

  // Account rows
  listRow:      { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  listRowLeft:  { flexDirection: 'row', alignItems: 'center', gap: 10 },
  listRowText:  { color: C.text, fontSize: 15, fontWeight: '600' },
  comingSoon:   { color: C.muted, fontSize: 12 },
  divider:      { height: 1, backgroundColor: C.border, marginVertical: 2 },

  // Injury
  injuryToggleRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  injuryToggleLeft: { flex: 1, paddingRight: 12 },
  injuryToggleTitle:{ color: C.text, fontSize: 14, fontWeight: '700' },
  injuryToggleSub:  { color: C.muted, fontSize: 12, marginTop: 2 },
  injuryDetails:    { marginTop: 12 },
  input:            { backgroundColor: C.input, borderWidth: 1, borderColor: C.border, borderRadius: 10, padding: 12, color: C.text, fontSize: 14, textAlignVertical: 'top' },
  saveBtn:          { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent, borderRadius: 10, paddingVertical: 12, marginTop: 10 },
  saveBtnText:      { color: '#000', fontWeight: '700', fontSize: 14 },

  // Garmin section special styling
  garminSection: { backgroundColor: '#0b0b0b', borderColor: 'rgba(234,179,8,0.35)' },
  garminSub:     { color: '#fde68a', fontSize: 13, marginBottom: 14 },
  garminStatusRow: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  statusDot:       { width: 8, height: 8, borderRadius: 4, backgroundColor: C.green },
  garminName:      { color: '#fef3c7', fontSize: 13, fontWeight: '700' },
  garminMeta:      { color: '#fcd34d', fontSize: 12, marginBottom: 10 },
  garminActions:   { flexDirection: 'row', gap: 10 },
  syncBtn:         { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.input, borderWidth: 1, borderColor: C.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  syncBtnText:     { color: C.accent, fontSize: 12, fontWeight: '700' },
  disconnectBtn:   { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: C.input, borderWidth: 1, borderColor: C.red, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  disconnectBtnText: { color: C.red, fontSize: 12, fontWeight: '700' },

  garminInputWrap:     { position: 'relative' },
  inputIcon:           { position: 'absolute', left: 10, top: 12, zIndex: 1 },
  garminInput:         { backgroundColor: '#151515', borderWidth: 1, borderColor: 'rgba(234,179,8,0.35)', borderRadius: 10, padding: 10, color: '#fef3c7', fontSize: 13 },
  garminInputWithIcon: { paddingLeft: 32 },
  garminConnectBtn:    { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#facc15', borderRadius: 10, paddingVertical: 12, marginTop: 10 },
  garminConnectText:   { color: '#111', fontWeight: '800', fontSize: 14 },

  notice:       { fontSize: 12, marginTop: 10 },
  privacyText:  { color: C.muted, fontSize: 13, lineHeight: 20 },

  signOutBtn:  { backgroundColor: C.card, borderWidth: 1, borderColor: C.red, borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 6 },
  signOutText: { color: C.red, fontSize: 14, fontWeight: '700' },
  deleteAccountBtn: { backgroundColor: C.card, borderWidth: 1, borderColor: '#b91c1c', borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 10 },
  deleteAccountBtnDisabled: { opacity: 0.6 },
  deleteAccountText: { color: '#fecaca', fontSize: 14, fontWeight: '700' },
  versionText: { textAlign: 'center', fontSize: 12, color: C.muted, opacity: 0.5, marginTop: 24 },
});
