/**
 * Small shared building blocks: colours, buttons, badges, empty states.
 * Plain React Native styles, no UI library.
 */
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View, useColorScheme, type ViewStyle } from "react-native";

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  accentText: string;
  danger: string;
  bubbleIn: string;
  bubbleOut: string;
  note: string;
  read: string;
}

const light: Palette = {
  bg: "#f6f5f2",
  surface: "#ffffff",
  surfaceAlt: "#efede8",
  text: "#1c1b19",
  muted: "#6b6862",
  border: "#dedbd4",
  accent: "#1f6f50",
  accentText: "#ffffff",
  danger: "#b3261e",
  bubbleIn: "#ffffff",
  bubbleOut: "#dcf3e6",
  note: "#fff4d6",
  read: "#2a7de1",
};

const dark: Palette = {
  bg: "#121211",
  surface: "#1c1c1a",
  surfaceAlt: "#262624",
  text: "#f1efea",
  muted: "#a29f98",
  border: "#34332f",
  accent: "#3fb07f",
  accentText: "#0b1a13",
  danger: "#f2867e",
  bubbleIn: "#22221f",
  bubbleOut: "#1d3a2c",
  note: "#3a3320",
  read: "#6fb0ff",
};

export function usePalette(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

export function Button(props: {
  title: string;
  onPress: () => void;
  kind?: "primary" | "secondary" | "danger";
  disabled?: boolean;
  busy?: boolean;
  style?: ViewStyle;
}): React.JSX.Element {
  const p = usePalette();
  const kind = props.kind ?? "primary";
  const bg = kind === "primary" ? p.accent : kind === "danger" ? p.danger : p.surfaceAlt;
  const fg = kind === "secondary" ? p.text : p.accentText;
  const disabled = props.disabled || props.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled, busy: !!props.busy }}
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1 },
        props.style,
      ]}
    >
      {props.busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.buttonText, { color: fg }]}>{props.title}</Text>}
    </Pressable>
  );
}

export function Badge({ count }: { count: number }): React.JSX.Element | null {
  const p = usePalette();
  if (count <= 0) return null;
  return (
    <View style={[styles.badge, { backgroundColor: p.accent }]}>
      <Text style={[styles.badgeText, { color: p.accentText }]}>{count > 99 ? "99+" : count}</Text>
    </View>
  );
}

export function Chip(props: { label: string; active?: boolean; onPress?: () => void }): React.JSX.Element {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!props.active }}
      onPress={props.onPress}
      style={[
        styles.chip,
        { borderColor: props.active ? p.accent : p.border, backgroundColor: props.active ? p.accent : p.surface },
      ]}
    >
      <Text style={{ color: props.active ? p.accentText : p.text, fontSize: 13, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}

export function Centered({ children }: { children: ReactNode }): React.JSX.Element {
  const p = usePalette();
  return <View style={[styles.centered, { backgroundColor: p.bg }]}>{children}</View>;
}

export function Message({ text, kind = "muted" }: { text: string; kind?: "muted" | "danger" }): React.JSX.Element {
  const p = usePalette();
  return <Text style={{ color: kind === "danger" ? p.danger : p.muted, textAlign: "center", padding: 16 }}>{text}</Text>;
}

const styles = StyleSheet.create({
  button: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: 16, fontWeight: "600" },
  badge: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  badgeText: { fontSize: 12, fontWeight: "700" },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, marginRight: 8 },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
});
