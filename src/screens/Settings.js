import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

const COLORS = {
  background: '#0f1117',
  card: '#171c27',
  accent: '#EAB308',
  text: '#FFFFFF',
  subtext: '#94a3b8',
  border: '#2c3345',
  input: '#1e2433'
};

export default function Settings() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Settings</Text>
      {['Account', 'Notifications', 'Units'].map((section) => (
        <View key={section} style={styles.card}>
          <Text style={styles.cardTitle}>{section}</Text>
          <Text style={styles.cardSub}>Coming Soon</Text>
        </View>
      ))}
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
    padding: 14,
    marginBottom: 10
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
