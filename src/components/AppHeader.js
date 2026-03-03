import React, { useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { HelpCircle, MessageSquare, Moon, Sun } from 'lucide-react-native';

export default function AppHeader({ readiness }) {
  const [darkMode, setDarkMode] = useState(true);

  return (
    <View style={styles.headerRow}>
      {/* Left: FORGE logo */}
      <Image
        source={require('../../assets/icon.png')}
        style={styles.logoMark}
      />

      {/* Center: READINESS label + yellow bar */}
      <View style={styles.readinessCenter}>
        <Text style={styles.readinessLabel}>READINESS</Text>
        <View style={styles.readinessBar} />
      </View>

      {/* Right: icons */}
      <View style={styles.headerIcons}>
        <Pressable onPress={() => setDarkMode(d => !d)} hitSlop={8}>
          {darkMode
            ? <Moon size={18} color="#64748b" />
            : <Sun size={18} color="#64748b" />
          }
        </Pressable>
        <Pressable hitSlop={8}>
          <MessageSquare size={18} color="#64748b" />
        </Pressable>
        <Pressable hitSlop={8}>
          <HelpCircle size={18} color="#64748b" />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#2c3345',
    backgroundColor: '#0f1117'
  },
  logoMark: {
    width: 36,
    height: 36,
    borderRadius: 10
  },
  readinessCenter: {
    alignItems: 'center',
    flex: 1
  },
  readinessLabel: {
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 3
  },
  readinessBar: {
    width: 32,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#EAB308'
  },
  headerIcons: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14
  }
});
