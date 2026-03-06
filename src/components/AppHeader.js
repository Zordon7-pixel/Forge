import React, { useContext, useMemo, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { HelpCircle, MessageSquare, Moon, Sun, User } from 'lucide-react-native';

import { AuthContext } from '../context/AuthContext';

export default function AppHeader({ readiness }) {
  const navigation = useNavigation();
  const { user } = useContext(AuthContext) || {};
  const [darkMode, setDarkMode] = useState(true);
  const initials = useMemo(() => {
    const name = String(user?.name || '').trim();
    if (!name) return '';
    const parts = name.split(' ').filter(Boolean);
    if (parts.length === 1) return parts[0][0].toUpperCase();
    return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  }, [user?.name]);

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
        <Pressable
          hitSlop={8}
          style={styles.profileButton}
          onPress={() => navigation.navigate('Profile')}
        >
          {initials ? (
            <Text style={styles.profileInitials}>{initials}</Text>
          ) : (
            <User size={14} color="#94a3b8" />
          )}
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
  },
  profileButton: {
    width: 26,
    height: 26,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: '#2c3345',
    backgroundColor: '#171c27',
    alignItems: 'center',
    justifyContent: 'center'
  },
  profileInitials: {
    fontSize: 10,
    fontWeight: '700',
    color: '#E2E8F0'
  }
});
