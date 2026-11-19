import { defineAddonSettings, SettingType } from "@pulsesync/addon-sdk";
export const settings = defineAddonSettings([
  {
    title: "Синхронизация PulseParty",
    items: {
      thresholdMs: {
        type: SettingType.NUMBER,
        name: "Допустимое расхождение, мс",
        description: "Мелкие расхождения не вызывают перемотку.",
        default: 800,
        min: 200,
        max: 5000,
        step: 100,
      },
      cooldownMs: {
        type: SettingType.NUMBER,
        name: "Интервал между коррекциями, мс",
        default: 3000,
        min: 500,
        max: 15000,
        step: 500,
      },
    },
  },
]);
