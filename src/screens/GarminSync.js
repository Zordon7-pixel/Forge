import React, { useCallback, useState } from 'react';
import { Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Link2, RefreshCw, ShieldCheck, ShieldX, Unplug } from 'lucide-react-native';

import {
  connectAccount,
  disconnect,
  getSyncMeta,
  isConnected,
  syncActivities
} from '../services/GarminConnect';

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
  const statusColor = connected ? '#22c55e' : '#64748b';
  const syncTimestamp = syncMeta?.lastSyncedAt ? new Date(syncMeta.lastSyncedAt).toLocaleString() : 'Never';
  const importedCount = syncMeta?.importedCount ?? 0;

  return (
    <ScrollView className="flex-1 bg-forge-bg px-4 pt-6">
      <Text className="text-2xl font-bold text-forge-text">Garmin Connect</Text>
      <Text className="mt-1 text-forge-subtext">Link Garmin and import workouts into FORGE.</Text>

      <View className="mt-5 rounded-2xl border border-forge-border bg-forge-card p-4">
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            {connected ? <ShieldCheck size={18} color="#EAB308" /> : <ShieldX size={18} color="#EAB308" />}
            <Text className="text-base font-semibold text-forge-text">Connection Status</Text>
          </View>
          <View className="flex-row items-center gap-2">
            <View className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: statusColor }} />
            <Text className="text-sm text-forge-subtext">{loadingState ? 'Checking...' : statusLabel}</Text>
          </View>
        </View>

        <View className="mt-4 rounded-xl border border-forge-border bg-forge-bg px-3 py-3">
          <Text className="text-xs uppercase tracking-wide text-forge-subtext">Last synced</Text>
          <Text className="mt-1 text-sm text-forge-text">{syncTimestamp}</Text>
          <Text className="mt-2 text-xs uppercase tracking-wide text-forge-subtext">Imported activities</Text>
          <Text className="mt-1 text-sm text-forge-text">{importedCount}</Text>
        </View>
      </View>

      {!connected && (
        <View className="mt-4 rounded-2xl border border-forge-border bg-forge-card p-4">
          <View className="flex-row items-center gap-2">
            <Link2 size={18} color="#EAB308" />
            <Text className="text-base font-semibold text-forge-text">Link Account</Text>
          </View>

          <TextInput
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            placeholder="Garmin email"
            placeholderTextColor="#64748b"
            className="mt-4 rounded-xl border border-forge-border bg-forge-bg px-4 py-3 text-forge-text"
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="Garmin password"
            placeholderTextColor="#64748b"
            className="mt-3 rounded-xl border border-forge-border bg-forge-bg px-4 py-3 text-forge-text"
          />

          <Pressable
            onPress={handleConnect}
            disabled={connecting}
            className="mt-4 flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3"
          >
            <Link2 size={18} color="#0f1117" />
            <Text className="font-semibold text-black">{connecting ? 'Connecting...' : 'Connect Account'}</Text>
          </Pressable>
        </View>
      )}

      {connected && (
        <View className="mt-4 gap-3 pb-8">
          <Pressable
            onPress={handleSync}
            disabled={syncing}
            className="flex-row items-center justify-center gap-2 rounded-xl bg-forge-accent px-4 py-3"
          >
            <RefreshCw size={18} color="#0f1117" />
            <Text className="font-semibold text-black">{syncing ? 'Syncing...' : 'Sync Now'}</Text>
          </Pressable>

          <Pressable
            onPress={handleDisconnect}
            className="flex-row items-center justify-center gap-2 rounded-xl border border-forge-border bg-forge-card px-4 py-3"
          >
            <Unplug size={18} color="#EAB308" />
            <Text className="font-semibold text-forge-text">Disconnect</Text>
          </Pressable>
        </View>
      )}
    </ScrollView>
  );
}

