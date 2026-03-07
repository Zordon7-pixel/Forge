import { createContext } from 'react';

export const AuthContext = createContext({
  token: null,
  user: null,
  onboardingComplete: false,
  signIn: async () => {},
  signOut: () => {},
  refreshUser: async () => {},
});
