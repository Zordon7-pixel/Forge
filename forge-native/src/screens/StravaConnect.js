import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import api from '../lib/api';
import { disconnect, getStatus, syncActivities } from '../services/Strava';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
};

const STRAVA_DEEPLINK = 'forge://strava-connect';

export default function StravaConnect() {
  const [status, setStatus] = useState({ connected: false, athlete_name: null, last_sync: null });
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const next = await getStatus();
      setStatus({
        connected: Boolean(next?.connected),
        athlete_name: next?.athlete_name || null,
        last_sync: next?.last_sync || null,
      });
    } catch {
      setStatus({ connected: false, athlete_name: null, last_sync: null });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    const sub = Linking.addEventListener('url', (event) => {
      if (!event?.url) return;
      if (event.url.startsWith(STRAVA_DEEPLINK)) {
        loadStatus();
      }
    });

    return () => {
      sub?.remove?.();
    };
  }, [loadStatus]);

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const response = await api.get('/strava/auth', {
        params: {
          format: 'json',
          deeplink: STRAVA_DEEPLINK,
        },
      });

      const authUrl = response?.data?.url;
      if (!authUrl) throw new Error('Unable to start Strava OAuth');

      await Linking.openURL(authUrl);
    } catch (err) {
      Alert.alert('Connect Failed', err?.response?.data?.error || err?.message || 'Unable to connect Strava right now.');
    } finally {
      setConnecting(false);
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      const result = await syncActivities();
      Alert.alert('Sync Complete', `Imported ${Number(result?.imported || 0)} activities`);
      await loadStatus();
    } catch (err) {
      Alert.alert('Sync Failed', err?.response?.data?.error || 'Unable to sync Strava activities.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      setDisconnecting(true);
      await disconnect();
      setStatus({ connected: false, athlete_name: null, last_sync: null });
    } catch (err) {
      Alert.alert('Disconnect Failed', err?.response?.data?.error || 'Unable to disconnect Strava right now.');
    } finally {
      setDisconnecting(false);
    }
  };

  const lastSyncLabel = status?.last_sync ? new Date(status.last_sync).toLocaleString() : 'Never';

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Strava</Text>
      <Text style={styles.subtitle}>Connect Strava and import your latest runs into FORGE.</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Status</Text>
        <Text style={styles.value}>{loading ? 'Checking...' : status.connected ? 'Connected' : 'Disconnected'}</Text>

        {status.connected ? (
          <>
            <Text style={styles.label}>Athlete</Text>
            <Text style={styles.value}>{status.athlete_name || 'Connected Athlete'}</Text>

            <Text style={styles.label}>Last Sync</Text>
            <Text style={styles.value}>{lastSyncLabel}</Text>

            <Pressable
              onPress={handleSync}
              disabled={syncing}
              style={[styles.button, syncing && styles.buttonDisabled]}
            >
              <Text style={styles.buttonText}>{syncing ? 'Syncing...' : 'Sync Activities'}</Text>
            </Pressable>

            <Pressable onPress={handleDisconnect} disabled={disconnecting} style={styles.disconnectWrap}>
              <Text style={styles.disconnectText}>{disconnecting ? 'Disconnecting...' : 'Disconnect'}</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={handleConnect}
            disabled={connecting}
            style={[styles.button, connecting && styles.buttonDisabled]}
          >
            <Text style={styles.buttonText}>{connecting ? 'Opening Strava...' : 'Connect Strava'}</Text>
          </Pressable>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: 24,
    paddingBottom: 32,
  },
  title: {
    color: COLORS.text,
    fontSize: 30,
    fontWeight: '700',
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 15,
    marginTop: 6,
  },
  card: {
    marginTop: 16,
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
  },
  label: {
    color: COLORS.subtext,
    fontSize: 12,
    letterSpacing: 0.3,
    textTransform: 'uppercase',
    marginTop: 12,
  },
  value: {
    color: COLORS.text,
    fontSize: 16,
    marginTop: 6,
  },
  button: {
    marginTop: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.accent,
    borderRadius: 12,
    paddingVertical: 12,
  },
  buttonDisabled: {
    opacity: 0.7,
  },
  buttonText: {
    color: COLORS.background,
    fontSize: 15,
    fontWeight: '700',
  },
  disconnectWrap: {
    marginTop: 14,
    alignItems: 'center',
  },
  disconnectText: {
    color: COLORS.subtext,
    textDecorationLine: 'underline',
    fontSize: 14,
  },
});
