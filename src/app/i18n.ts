import i18n from "i18next";
import { initReactI18next } from "react-i18next";

i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: { title: "新闻直播编排台", rundown: "串联单", changes: "突发变更", queue: "应急队列", history: "操作历史", conflicts: "合并确认" } },
    en: { translation: { title: "News Rundown Control", rundown: "Rundown", changes: "Breaking changes", queue: "Offline queue", history: "History", conflicts: "Merge review" } }
  },
  lng: "zh",
  fallbackLng: "zh",
  interpolation: { escapeValue: false }
});

export default i18n;
