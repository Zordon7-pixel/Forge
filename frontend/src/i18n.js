import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import en from './locales/en.json'
import es from './locales/es.json'
import ptBR from './locales/pt-BR.json'
import de from './locales/de.json'
import fr from './locales/fr.json'
import ja from './locales/ja.json'

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { 
      en: { translation: en }, 
      es: { translation: es }, 
      'pt-BR': { translation: ptBR }, 
      de: { translation: de }, 
      fr: { translation: fr }, 
      ja: { translation: ja } 
    },
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
    detection: { order: ['localStorage', 'navigator'], caches: ['localStorage'] },
    react: { useSuspense: false }
  })

export default i18n
