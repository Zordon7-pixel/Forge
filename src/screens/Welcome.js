import React from 'react';
import { Image, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Brain, Watch, Sparkles } from 'lucide-react-native';

const features = [
  { Icon: Brain, title: 'Personalized Training', text: 'Plans adapt to your recovery, goals, and consistency each week.' },
  { Icon: Watch, title: 'Watch Integration', text: 'Sync from wearables or import activity files when sync is unavailable.' },
  { Icon: Sparkles, title: 'AI Coach Feedback', text: 'Get targeted guidance for effort, load management, and race prep.' },
];

export default function Welcome({ navigation }) {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.hero}>
          <Image source={require('../../assets/icon.png')} style={styles.icon} />
          <Text style={styles.brand}>FORGE</Text>
          <Text style={styles.headline}>Built to adapt.{'\n'}AI coaching that learns your body.</Text>
          <Text style={styles.subtitle}>
            Train smarter with adaptive plans, real performance feedback, and seamless activity sync.
          </Text>

          <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('Register')}>
            <Text style={styles.primaryBtnText}>Get Started</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('Login')}>
            <Text style={styles.secondaryBtnText}>Sign In</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.features}>
          {features.map((f) => (
            <View key={f.title} style={styles.card}>
              <f.Icon size={22} color="#EAB308" />
              <Text style={styles.cardTitle}>{f.title}</Text>
              <Text style={styles.cardText}>{f.text}</Text>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0f1117',
  },
  scroll: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },
  hero: {
    alignItems: 'center',
    paddingTop: 48,
    paddingBottom: 32,
  },
  icon: {
    width: 72,
    height: 72,
    borderRadius: 16,
    marginBottom: 16,
  },
  brand: {
    fontSize: 14,
    letterSpacing: 4,
    color: '#EAB308',
    fontWeight: '700',
    marginBottom: 16,
  },
  headline: {
    fontSize: 28,
    fontWeight: '900',
    color: '#FFFFFF',
    textAlign: 'center',
    lineHeight: 36,
  },
  subtitle: {
    fontSize: 15,
    color: '#a1a1aa',
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 22,
    maxWidth: 320,
  },
  primaryBtn: {
    marginTop: 28,
    backgroundColor: '#EAB308',
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#0f1117',
    fontSize: 16,
    fontWeight: '800',
  },
  secondaryBtn: {
    marginTop: 12,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2c3345',
    paddingVertical: 14,
    paddingHorizontal: 32,
    width: '100%',
    alignItems: 'center',
  },
  secondaryBtnText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '600',
  },
  features: {
    gap: 12,
    paddingTop: 8,
  },
  card: {
    backgroundColor: '#171c27',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#2c3345',
    padding: 20,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
    marginTop: 10,
  },
  cardText: {
    fontSize: 13,
    color: '#a1a1aa',
    marginTop: 6,
    lineHeight: 19,
  },
});
