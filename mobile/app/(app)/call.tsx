/** In-call screen: who, timer, mute, speaker, hang up. Closes itself when the call ends. */
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { usePalette } from "../../src/components/ui";
import { humanizeError } from "../../src/lib/api";
import { formatDuration } from "../../src/lib/inbox-logic";
import { hangUp, toggleMute, toggleSpeaker, useVoice } from "../../src/lib/voice";

export default function CallScreen(): React.JSX.Element {
  const p = usePalette();
  const router = useRouter();
  const active = useVoice((s) => s.active);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Call over: go back (the reason, if any, is shown by the app layout).
  useEffect(() => {
    if (active) return;
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [active, router]);

  if (!active) return <View style={{ flex: 1, backgroundColor: p.bg }} />;

  const status =
    active.state === "open" && active.startedAt
      ? formatDuration((now - active.startedAt) / 1000)
      : active.state === "ringing"
        ? "Ringing…"
        : active.state === "reconnecting"
          ? "Reconnecting…"
          : "Connecting…";

  const act = (fn: () => Promise<void>) => () => {
    fn().catch((err: unknown) => Alert.alert("Call", humanizeError(err)));
  };

  return (
    <SafeAreaView style={[styles.wrap, { backgroundColor: p.bg }]}>
      <View style={{ alignItems: "center", marginTop: 48 }}>
        <Text style={{ color: p.muted }}>{active.direction === "in" ? "Incoming call" : "Outgoing call"}</Text>
        <Text style={{ color: p.text, fontSize: 28, fontWeight: "700", marginTop: 8 }} numberOfLines={1}>
          {active.who}
        </Text>
        <Text style={{ color: p.muted, fontSize: 18, marginTop: 8 }} accessibilityLiveRegion="polite">
          {status}
        </Text>
      </View>
      <View style={styles.controls}>
        <Control label={active.muted ? "Unmute" : "Mute"} on={active.muted} onPress={act(toggleMute)} />
        <Control label="Speaker" on={active.speaker} onPress={act(toggleSpeaker)} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Hang up"
        onPress={act(hangUp)}
        style={[styles.hangup, { backgroundColor: p.danger }]}
      >
        <Text style={{ color: "#fff", fontSize: 18, fontWeight: "700" }}>Hang up</Text>
      </Pressable>
    </SafeAreaView>
  );
}

function Control(props: { label: string; on: boolean; onPress: () => void }): React.JSX.Element {
  const p = usePalette();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: props.on }}
      onPress={props.onPress}
      style={[styles.control, { backgroundColor: props.on ? p.accent : p.surfaceAlt }]}
    >
      <Text style={{ color: props.on ? p.accentText : p.text, fontWeight: "600" }}>{props.label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "space-between", padding: 24 },
  controls: { flexDirection: "row", justifyContent: "center", gap: 24 },
  control: { width: 96, height: 96, borderRadius: 48, alignItems: "center", justifyContent: "center" },
  hangup: { height: 64, borderRadius: 32, alignItems: "center", justifyContent: "center", marginBottom: 24 },
});
