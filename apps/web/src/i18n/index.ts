/**
 * i18next 国际化配置
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import en from './locales/en.json';
import ru from './locales/ru.json';
import { getInitialLanguage } from '@/utils/language';
import { clusterEN, clusterZH } from './cluster';

i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': { translation: { ...zhCN, cluster: clusterZH } },
    'zh-TW': { translation: { ...zhTW, cluster: clusterZH } },
    en: { translation: { ...en, cluster: clusterEN } },
    ru: { translation: { ...ru, cluster: clusterEN } },
  },
  lng: getInitialLanguage(),
  fallbackLng: 'zh-CN',
  interpolation: {
    escapeValue: false, // React 已经转义
  },
  react: {
    useSuspense: false,
  },
});

export default i18n;
