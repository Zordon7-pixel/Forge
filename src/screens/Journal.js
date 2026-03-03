import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345'
};

export default function Journal() {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView style={[styles.container, { paddingTop: insets.top }]} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Journal</Text>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Journal Entries</Text>
        <Text style={styles.cardSub}>Coming Soon</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background
  },
  content: {
    padding: 16
  },
  title: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 10
  },
  card: {
    backgroundColor: COLORS.card,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderRadius: 14,
    padding: 14
  },
  cardTitle: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '700'
  },
  cardSub: {
    color: COLORS.subtext,
    fontSize: 12,
    marginTop: 4
  }
});
