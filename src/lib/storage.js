import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'forge_token';

export const getToken = async () => {
  try {
    return await SecureStore.getItemAsync(TOKEN_KEY);
  } catch {
    return null;
  }
};

export const setToken = async (token) => {
  await SecureStore.setItemAsync(TOKEN_KEY, token);
};

export const clearToken = async () => {
  await SecureStore.deleteItemAsync(TOKEN_KEY);
};

export { TOKEN_KEY };
