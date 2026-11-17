/**
 * The signed-in part of the app. Sets up, once per session:
 *   - push: register this phone (POST /inbox/devices) on sign-in and every launch / return to the app
 *   - tapping a message push opens that conversation (data.conversationId)
 *   - calls: Twilio Voice registration, the incoming-call banner, the in-call screen
 *   - sign-out hooks: DELETE the push token and stop calls before the session ends
 */
import { useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import { Redirect, Stack, useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import { ActivityIndicator, Alert, AppState, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Centered, usePalette } from "../../src/components/ui";
import { addSignOutHook, useAuth, useUser } from "../../src/lib/auth";
import { inboxKeys } from "../../src/lib/inbox-api";
import { conversationIdFromPush } from "../../src/lib/inbox-logic";
import { registerForPush, unregisterPush } from "../../src/lib/push";
import { acceptIncoming, clearNotice, declineIncoming, startVoice, stopVoice, useVoice } from "../../src/lib/voice";

export default function AppLayout(): React.JSX.Element {
  const { state } = useAuth();
  if (state.kind === "loading") {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  if (state.kind !== "ready") return <Redirect href="/login" />;
  return (
    <>
      <SessionEffects />
      <Stack>
        <Stack.Screen name="index" options={{ title: "Inbox" }} />
        <Stack.Screen name="conversation/[id]" options={{ title: "" }} />
        <Stack.Screen name="contact/[id]" options={{ title: "Contact" }} />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="call" options={{ presentation: "fullScreenModal", headerShown: false, gestureEnabled: false }} />
      </Stack>
      <IncomingCallBanner />
    </>
  );
}

function SessionEffects(): null {
  const user = useUser();
  const router = useRouter();
  const qc = useQueryClient();
  const active = useVoice((s) => s.active !== null);
  const notice = useVoice((s) => s.notice);
  const handledColdStart = useRef(false);

  // Push + calls for this user; undone on sign-out (hooks run while the cookie is still valid).
  useEffect(() => {
    const caps = user.capabilities;
    void registerForPush().catch(() => undefined);
    void startVoice({ canAnswer: caps.includes("calls.answer"), canCall: caps.includes("calls.outbound") });
    const removeHook = addSignOutHook(async () => {
      await Promise.allSettled([unregisterPush(), stopVoice()]);
      qc.clear();
    });
    // Re-check in on every return to the app: keeps the token fresh on the server,
    // which is what lets a closed phone keep ringing (the API's 12-hour window).
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void registerForPush().catch(() => undefined);
    });
    return () => {
      removeHook();
      sub.remove();
    };
  }, [user.id, user.capabilities, qc]);

  // Tapping a message push opens the conversation.
  useEffect(() => {
    const open = (data: unknown): void => {
      const id = conversationIdFromPush(data);
      if (id) router.push(`/conversation/${id}`);
    };
    if (!handledColdStart.current) {
      handledColdStart.current = true;
      void Notifications.getLastNotificationResponseAsync().then((r) => {
        if (r) open(r.notification.request.content.data);
      });
    }
    const tapSub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification.request.content.data));
    // A push arriving while open means something changed: refresh lists now rather than at the next poll.
    const recvSub = Notifications.addNotificationReceivedListener(() => {
      void qc.invalidateQueries({ queryKey: inboxKeys.all });
    });
    return () => {
      tapSub.remove();
      recvSub.remove();
    };
  }, [router, qc]);

  // A call started (answered or dialled): show the in-call screen.
  useEffect(() => {
    if (active) router.push("/call");
  }, [active, router]);

  // One-off call messages ("someone else answered", "couldn't connect").
  useEffect(() => {
    if (!notice || active) return;
    Alert.alert("Call", notice);
    clearNotice();
  }, [notice, active]);

  return null;
}

function IncomingCallBanner(): React.JSX.Element | null {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const incoming = useVoice((s) => s.incoming);
  if (!incoming) return null;
  return (
    <View style={[styles.banner, { top: insets.top + 8, backgroundColor: p.surface, borderColor: p.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: p.muted, fontSize: 12 }}>Incoming call</Text>
        <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
          {incoming.from}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Decline call"
        onPress={() => void declineIncoming()}
        style={[styles.round, { backgroundColor: p.danger }]}
      >
        <Text style={styles.roundText}>Decline</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Answer call"
        onPress={() => void acceptIncoming()}
        style={[styles.round, { backgroundColor: p.accent }]}
      >
        <Text style={styles.roundText}>Answer</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    flexDirection: "row",
    alignItems: "center",
    padding: 12,
    borderRadius: 14,
    borderWidth: 1,
    gap: 8,
    elevation: 6,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  round: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: 22 },
  roundText: { color: "#fff", fontWeight: "700" },
});
