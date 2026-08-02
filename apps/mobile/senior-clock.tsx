import { useEffect, useMemo, useState } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { useLanguage } from "./language";
import { formatSeniorDateTime } from "./senior-date-time";

type Props = {
  compact: boolean;
  tablet: boolean;
};

export function SeniorClock({ compact, tablet }: Props) {
  const { language } = useLanguage();
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let minuteTimeout: ReturnType<typeof setTimeout> | undefined;

    const refreshAndSchedule = () => {
      if (minuteTimeout) clearTimeout(minuteTimeout);
      const currentTime = new Date();
      setNow(currentTime);
      const millisecondsUntilNextMinute =
        60_000 - (currentTime.getSeconds() * 1_000 + currentTime.getMilliseconds());
      minuteTimeout = setTimeout(refreshAndSchedule, millisecondsUntilNextMinute + 50);
    };

    refreshAndSchedule();
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshAndSchedule();
    });

    return () => {
      if (minuteTimeout) clearTimeout(minuteTimeout);
      appStateSubscription.remove();
    };
  }, []);

  const formatted = useMemo(
    () => formatSeniorDateTime(now, language),
    [language, now],
  );

  return (
    <View
      accessibilityLabel={`${formatted.weekday}, ${formatted.date}, ${formatted.time}`}
      accessibilityRole="header"
      accessible
      pointerEvents="none"
      style={[styles.container, compact && styles.containerCompact]}
    >
      <Text
        numberOfLines={1}
        style={[
          styles.weekday,
          tablet && styles.weekdayTablet,
          compact && styles.weekdayCompact,
        ]}
      >
        {formatted.weekday}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.date,
          tablet && styles.dateTablet,
          compact && styles.dateCompact,
        ]}
      >
        {formatted.date}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.time,
          tablet && styles.timeTablet,
          compact && styles.timeCompact,
        ]}
      >
        {formatted.time}
      </Text>
    </View>
  );
}

const clearSystemFont = Platform.select({
  android: "sans-serif",
  default: "System",
});

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: 2,
    width: "100%",
  },
  containerCompact: {
    gap: 0,
  },
  weekday: {
    color: "#fafaf9",
    fontFamily: clearSystemFont,
    fontSize: 38,
    fontWeight: "700",
    lineHeight: 46,
    textAlign: "center",
  },
  weekdayTablet: {
    fontSize: 48,
    lineHeight: 57,
  },
  weekdayCompact: {
    fontSize: 30,
    lineHeight: 36,
  },
  date: {
    color: "#e7e5e4",
    fontFamily: clearSystemFont,
    fontSize: 30,
    fontWeight: "600",
    lineHeight: 38,
    textAlign: "center",
  },
  dateTablet: {
    fontSize: 38,
    lineHeight: 46,
  },
  dateCompact: {
    fontSize: 24,
    lineHeight: 30,
  },
  time: {
    color: "#fbbf24",
    fontFamily: clearSystemFont,
    fontSize: 76,
    fontVariant: ["tabular-nums"],
    fontWeight: "700",
    lineHeight: 88,
    textAlign: "center",
  },
  timeTablet: {
    fontSize: 96,
    lineHeight: 108,
  },
  timeCompact: {
    fontSize: 60,
    lineHeight: 69,
  },
});
