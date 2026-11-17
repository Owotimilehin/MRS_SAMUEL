import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Constants from "expo-constants";
import { useState } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { Button, Chip, Message, usePalette } from "../../src/components/ui";
import { humanizeError } from "../../src/lib/api";
import { useAuth, useUser } from "../../src/lib/auth";
import { API_BASE_URL } from "../../src/lib/config";
import { inboxApi, inboxKeys } from "../../src/lib/inbox-api";
import type { NotifyLevel } from "../../src/lib/inbox-types";
import { registerForPush } from "../../src/lib/push";
import { setAvailable, useVoice } from "../../src/lib/voice";

const LEVELS: { level: NotifyLevel; label: string; help: string }[] = [
  { level: "assigned", label: "Mine", help: "Chats assigned to me, or unassigned in my teams" },
  { level: "all", label: "Everything", help: "Every chat I can see" },
  { level: "none", label: "Off", help: "No message notifications" },
];

export default function SettingsScreen(): React.JSX.Element {
  const p = usePalette();
  const user = useUser();
  const { signOut } = useAuth();
  const qc = useQueryClient();
  const [signingOut, setSigningOut] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);

  const voiceStatus = useVoice((s) => s.status);
  const voiceMessage = useVoice((s) => s.message);
  const available = useVoice((s) => s.available);
  const canAnswer = useVoice((s) => s.canAnswer);

  const level = useQuery({ queryKey: inboxKeys.notifications, queryFn: inboxApi.notificationLevel });
  const setLevel = useMutation({
    mutationFn: inboxApi.setNotificationLevel,
    onSuccess: (lvl) => qc.setQueryData(inboxKeys.notifications, lvl),
    onError: (err) => Alert.alert("Couldn't save", humanizeError(err)),
  });

  const toggleAvailable = async (v: boolean): Promise<void> => {
    try {
      await setAvailable(v);
    } catch (err) {
      Alert.alert("Couldn't change call availability", humanizeError(err));
    }
  };

  const checkPush = async (): Promise<void> => {
    try {
      const r = await registerForPush();
      setPushNote(r.ok ? "This phone is set up for notifications." : r.reason);
    } catch (err) {
      setPushNote(humanizeError(err));
    }
  };

  const doSignOut = (): void => {
    Alert.alert("Sign out?", "This phone will stop getting notifications and calls.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Sign out",
        style: "destructive",
        onPress: () => {
          setSigningOut(true);
          void signOut().finally(() => setSigningOut(false));
        },
      },
    ]);
  };

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ padding: 16 }}>
      <Text style={{ color: p.muted }}>Signed in as</Text>
      <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }}>{user.email}</Text>

      {canAnswer ? (
        <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
          <View style={styles.row}>
            <View style={{ flex: 1, marginRight: 12 }}>
              <Text style={{ color: p.text, fontSize: 16, fontWeight: "600" }}>Available for calls</Text>
              <Text style={{ color: p.muted, fontSize: 13 }}>
                When on, customer calls ring this phone, even when the app is closed.
              </Text>
            </View>
            <Switch
              value={available}
              onValueChange={(v) => void toggleAvailable(v)}
              disabled={voiceStatus !== "ready"}
              accessibilityLabel="Available for calls"
            />
          </View>
          {voiceStatus !== "ready" && voiceStatus !== "starting" ? (
            <Text style={{ color: p.danger, fontSize: 13, marginTop: 6 }}>
              {voiceMessage ?? "Calls aren't working on this phone right now."}
            </Text>
          ) : null}
        </View>
      ) : null}

      <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.border }]}>
        <Text style={{ color: p.text, fontSize: 16, fontWeight: "600", marginBottom: 8 }}>Message notifications</Text>
        {level.isError ? <Message kind="danger" text={humanizeError(level.error)} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
          {LEVELS.map((l) => (
            <Chip key={l.level} label={l.label} active={level.data === l.level} onPress={() => setLevel.mutate(l.level)} />
          ))}
        </View>
        <Text style={{ color: p.muted, fontSize: 13, marginTop: 8 }}>
          {LEVELS.find((l) => l.level === level.data)?.help ?? ""}
        </Text>
        <Button title="Check notifications on this phone" kind="secondary" style={{ marginTop: 12 }} onPress={() => void checkPush()} />
        {pushNote ? <Text style={{ color: p.muted, fontSize: 13, marginTop: 6 }}>{pushNote}</Text> : null}
      </View>

      <Button title="Sign out" kind="danger" busy={signingOut} onPress={doSignOut} style={{ marginTop: 24 }} />

      <Text style={{ color: p.muted, fontSize: 12, marginTop: 24, textAlign: "center" }}>
        MS Staff {Constants.expoConfig?.version ?? ""} · {API_BASE_URL}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 16 },
  row: { flexDirection: "row", alignItems: "center" },
});
