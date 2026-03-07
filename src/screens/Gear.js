import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react-native';

import api from '../lib/api';
import AppHeader from '../components/AppHeader';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  error: '#ef4444',
};

const THRESHOLD = 450;

export default function Gear() {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [shoes, setShoes] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [nickname, setNickname] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const response = await api.get('/gear/shoes');
      setShoes(response?.data?.shoes || []);
    } catch (loadError) {
      setError(loadError?.response?.data?.message || 'Could not load gear.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const addShoe = async () => {
    if (!brand.trim() || !model.trim()) {
      setError('Brand and model are required.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.post('/gear/shoes', {
        brand: brand.trim(),
        model: model.trim(),
        nickname: nickname.trim() || undefined,
      });
      setShowAdd(false);
      setBrand('');
      setModel('');
      setNickname('');
      load(true);
    } catch (postError) {
      setError(postError?.response?.data?.message || 'Unable to add shoe.');
    } finally {
      setSaving(false);
    }
  };

  const retireShoe = async (id) => {
    setError('');
    try {
      await api.post(`/gear/shoes/${id}/retire`);
      setShoes((prev) => prev.filter((item) => item.id !== id));
    } catch (postError) {
      setError(postError?.response?.data?.message || 'Unable to retire shoe.');
    }
  };

  const deleteShoe = async (id) => {
    setError('');
    try {
      await api.delete(`/gear/shoes/${id}`);
      setShoes((prev) => prev.filter((item) => item.id !== id));
    } catch (deleteError) {
      setError(deleteError?.response?.data?.message || 'Unable to delete shoe.');
    }
  };

  const alertCount = useMemo(() => shoes.filter((shoe) => Number(shoe.total_miles || 0) >= THRESHOLD).length, [shoes]);

  return (
    <ScrollView
      style={[styles.container, { paddingTop: insets.top }]}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl tintColor={COLORS.accent} refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(true); }} />}
    >
      <AppHeader />

      <View style={styles.heroCard}>
        <Text style={styles.title}>Gear</Text>
        <Text style={styles.subtitle}>{shoes.length} active shoes</Text>
        <Pressable style={styles.addButton} onPress={() => setShowAdd(true)}>
          <Plus color="#000" size={14} />
          <Text style={styles.addButtonText}>Add Shoe</Text>
        </Pressable>
      </View>

      {!!error && (
        <View style={styles.errorCard}><Text style={styles.errorText}>{error}</Text></View>
      )}

      {alertCount > 0 && (
        <View style={styles.alertCard}>
          <AlertTriangle color="#f97316" size={15} />
          <Text style={styles.alertText}>{alertCount} shoe(s) passed {THRESHOLD} miles</Text>
        </View>
      )}

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={COLORS.accent} />
          <Text style={styles.loadingText}>Loading shoes...</Text>
        </View>
      ) : null}

      {!loading && shoes.length === 0 ? (
        <View style={styles.card}><Text style={styles.emptyText}>No shoes yet. Add your first pair.</Text></View>
      ) : null}

      {!loading && shoes.map((shoe, idx) => {
        const miles = Number(shoe.total_miles || 0);
        const pct = Math.min(100, (miles / THRESHOLD) * 100);
        const barColor = miles >= THRESHOLD ? COLORS.error : miles >= 350 ? COLORS.accent : '#22c55e';

        return (
          <View key={shoe.id || `shoe-${idx}`} style={styles.card}>
            {miles >= THRESHOLD ? (
              <View style={styles.replaceBanner}><Text style={styles.replaceText}>Replace soon</Text></View>
            ) : null}

            <View style={styles.rowBetween}>
              <View>
                <Text style={styles.shoeName}>{shoe.brand} {shoe.model}</Text>
                {!!shoe.nickname && <Text style={styles.shoeNick}>{shoe.nickname}</Text>}
              </View>
              <Text style={[styles.percent, { color: barColor }]}>{Math.round((miles / THRESHOLD) * 100)}%</Text>
            </View>

            <View style={styles.progressTrack}><View style={[styles.progressBar, { width: `${pct}%`, backgroundColor: barColor }]} /></View>
            <Text style={styles.progressText}>{miles.toFixed(1)} / {THRESHOLD} mi</Text>

            <View style={styles.actions}>
              <Pressable style={styles.secondaryButton} onPress={() => retireShoe(shoe.id)}>
                <Text style={styles.secondaryButtonText}>Retire</Text>
              </Pressable>
              <Pressable
                style={styles.deleteButton}
                onPress={() => Alert.alert('Delete Shoe', 'Delete this shoe from your inventory?', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => deleteShoe(shoe.id) },
                ])}
              >
                <Trash2 color={COLORS.error} size={14} />
                <Text style={styles.deleteButtonText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        );
      })}

      <Modal visible={showAdd} transparent={true} animationType="slide" onRequestClose={() => setShowAdd(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowAdd(false)}>
          <Pressable style={styles.modalCard} onPress={(event) => event.stopPropagation()}>
            <Text style={styles.modalTitle}>Add Shoe</Text>

            <TextInput
              value={brand}
              onChangeText={setBrand}
              placeholder="Brand"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
            />
            <TextInput
              value={model}
              onChangeText={setModel}
              placeholder="Model"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
            />
            <TextInput
              value={nickname}
              onChangeText={setNickname}
              placeholder="Nickname (optional)"
              placeholderTextColor={COLORS.subtext}
              style={styles.input}
            />

            <Pressable style={styles.addButton} onPress={addShoe} disabled={saving}>
              <Text style={styles.addButtonText}>{saving ? 'Adding...' : 'Save Shoe'}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
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
    paddingTop: 12,
    paddingBottom: 30,
  },
  heroCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '900',
  },
  subtitle: {
    color: COLORS.subtext,
    fontSize: 13,
    marginTop: 4,
  },
  addButton: {
    marginTop: 12,
    borderRadius: 12,
    backgroundColor: COLORS.accent,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    paddingVertical: 12,
  },
  addButtonText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '800',
  },
  errorCard: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: '#7f1d1d',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  errorText: {
    color: '#fca5a5',
    fontSize: 13,
  },
  alertCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    backgroundColor: 'rgba(249,115,22,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(249,115,22,0.4)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 10,
  },
  alertText: {
    color: '#fdba74',
    fontSize: 12,
    fontWeight: '700',
  },
  loadingWrap: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 8,
  },
  loadingText: {
    color: COLORS.subtext,
    fontSize: 13,
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
  },
  emptyText: {
    color: COLORS.subtext,
    fontSize: 14,
  },
  replaceBanner: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    backgroundColor: 'rgba(239,68,68,0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    marginBottom: 8,
  },
  replaceText: {
    color: '#fca5a5',
    fontSize: 11,
    fontWeight: '700',
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  shoeName: {
    color: COLORS.text,
    fontSize: 15,
    fontWeight: '800',
  },
  shoeNick: {
    color: COLORS.accent,
    fontSize: 12,
    marginTop: 2,
  },
  percent: {
    fontSize: 22,
    fontWeight: '900',
  },
  progressTrack: {
    marginTop: 10,
    height: 8,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: '#111827',
  },
  progressBar: {
    height: 8,
    borderRadius: 999,
  },
  progressText: {
    color: COLORS.subtext,
    fontSize: 11,
    marginTop: 5,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    alignItems: 'center',
    paddingVertical: 10,
  },
  secondaryButtonText: {
    color: COLORS.subtext,
    fontSize: 13,
    fontWeight: '700',
  },
  deleteButton: {
    flex: 1,
    borderWidth: 1,
    borderColor: 'rgba(239,68,68,0.35)',
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 6,
    paddingVertical: 10,
    backgroundColor: 'rgba(239,68,68,0.08)',
  },
  deleteButtonText: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.65)',
  },
  modalCard: {
    backgroundColor: COLORS.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    padding: 16,
    gap: 10,
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '900',
  },
  input: {
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 10,
    backgroundColor: '#111827',
    color: COLORS.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
});
