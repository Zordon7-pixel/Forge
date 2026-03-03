import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Link2, RefreshCw, ShieldCheck, ShieldX, Unplug } from 'lucide-react-native';

import {
  connectAccount,
  disconnect,
  getSyncMeta,
  isConnected,
  syncActivities
} from '../services/GarminConnect';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  success: '#22c55e',
  error: '#ef4444'
};

export default function GarminSync() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [connected, setConnected] = useState(false);
  const [loadingState, setLoadingState] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMeta, setSyncMeta] = useState(null);

  const loadState = useCallback(async () => {
    try {
      const [connectionState, meta] = await Promise.all([isConnected(), getSyncMeta()]);
      setConnected(connectionState);
      setSyncMeta(meta);
    } finally {
      setLoadingState(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      setLoadingState(true);
      loadState();
    }, [loadState])
  );

  const handleConnect = async () => {
    try {
      setConnecting(true);
      await connectAccount(email, password);
      setConnected(true);
      setPassword('');
      Alert.alert('Connected', 'Garmin Connect account linked.');
    } catch (error) {
      Alert.alert('Connection Failed', error?.message || 'Unable to connect to Garmin Connect.');
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      const result = await syncActivities();
      setSyncMeta(result);
      Alert.alert(
        'Sync Complete',
        `${result.importedCount} activities imported (${result.importedRuns} runs, ${result.importedLifts} lifts).`
      );
    } catch (error) {
      Alert.alert('Sync Failed', error?.message || 'Unable to sync Garmin activities.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnect();
      setConnected(false);
      setSyncMeta(null);
      setEmail('');
      setPassword('');
      Alert.alert('Disconnected', 'Garmin Connect account removed.');
    } catch (error) {
      Alert.alert('Disconnect Failed', error?.message || 'Unable to disconnect Garmin Connect.');
    }
  };

  const statusLabel = connected ? 'Connected' : 'Not Connected';
  const statusColor = connected ? COLORS.success : COLORS.subtext;
  const syncTimestamp = syncMeta?.lastSyncedAt ? new Date(syncMeta.lastSyncedAt).toLocaleString() : 'Never';
  const importedCount = syncMeta?.importedCount ?? 0;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Garmin Connect</Text>
      <Text style={styles.subtitle}>Link Garmin and import workouts into FORGE.</Text>

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.rowStart}>
            {connected ? <ShieldCheck size={18} color={COLORS.accent} /> : <ShieldX size={18} color={COLORS.accent} />}
            <Text style={styles.cardTitle}>Connection Status</Text>
          </View>
          <View style={styles.rowStart}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={styles.statusText}>{loadingState ? 'Checking...' : statusLabel}</Text>
          </View>
        </View>

        <View style={styles.metaBox}>
          <Text style={styles.metaHeading}>Last synced</Text>
          <Text style={styles.metaValue}>{syncTimestamp}</Text>
          <Text style={styles.metaHeading}>Imported activities</Text>
          <Text style={styles.metaValue}>{importedCount}</Text>
        </View>
      </View>

      {!connected && (
        <View style={styles.card}>
          <View style={styles.rowStart}>
            <Link2 size={18} color={COLORS.accent} />
            <Text style={styles.cardTitle}>Link Account</Text>
          </View>

          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Garmin email"
            placeholderTextColor={COLORS.subtext}
            style={styles.input}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Garmin password"
            placeholderTextColor={COLORS.subtext}
            style={[styles.input, styles.inputSpacing]}
          />

          <Pressable onPress={handleConnect} disabled={connecting} style={[styles.primaryButton, connecting && styles.disabledButton]}>
            <Link2 size={18} color={COLORS.background} />
            <Text style={styles.primaryButtonText}>{connecting ? 'Connecting...' : 'Connect Account'}</Text>
          </Pressable>
        </View>
      )}

      {connected && (
        <View style={styles.actionsWrap}>
          <Pressable onPress={handleSync} disabled={syncing} style={[styles.primaryButton, syncing && styles.disabledButton]}>
            <RefreshCw size={18} color={COLORS.background} />
            <Text style={styles.primaryButtonText}>{syncing ? 'Syncing...' : 'Sync Now'}</Text>
          </Pressable>

          <Pressable onPress={handleDisconnect} style={styles.secondaryButton}>
            <Unplug size={18} color={COLORS.accent} />
            <Text style={styles.secondaryButtonText}>Disconnect</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 32
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700'
  },
  subtitle: {
    color: COLORS.subtext,
    marginTop: 4,
    fontSize: 15
  },
  card: {
    marginTop: 16,
    backgroundColor: COLORS.card,
    borderColor: COLORS.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: 16
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  rowStart: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 17,
    fontWeight: '600',
    marginLeft: 8
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginRight: 6
  },
  statusText: {
    color: COLORS.subtext,
    fontSize: 13
  },
  metaBox: {
    marginTop: 14,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    padding: 12
  },
  metaHeading: {
    color: COLORS.subtext,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 4
  },
  metaValue: {
    color: COLORS.text,
    fontSize: 14,
    marginBottom: 10
  },
  input: {
    marginTop: 14,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.background,
    borderRadius: 12,
    color: COLORS.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15
  },
  inputSpacing: {
    marginTop: 10
  },
  primaryButton: {
    marginTop: 14,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  primaryButtonText: {
    color: COLORS.background,
    fontWeight: '700',
    marginLeft: 8,
    fontSize: 15
  },
  actionsWrap: {
    marginTop: 16
  },
  secondaryButton: {
    marginTop: 10,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.card,
    paddingVertical: 14,
    justifyContent: 'center',
    alignItems: 'center',
    flexDirection: 'row'
  },
  secondaryButtonText: {
    color: COLORS.text,
    fontWeight: '600',
    marginLeft: 8,
    fontSize: 15
  },
  disabledButton: {
    opacity: 0.7
  }
});
