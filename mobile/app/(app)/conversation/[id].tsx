import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Composer } from "../../../src/components/Composer";
import { DayHeader, TimelineEntry } from "../../../src/components/Timeline";
import { Centered, Chip, Message, usePalette } from "../../../src/components/ui";
import { humanizeError } from "../../../src/lib/api";
import { useUser } from "../../../src/lib/auth";
import { POLL_MS } from "../../../src/lib/config";
import { inboxApi, inboxKeys } from "../../../src/lib/inbox-api";
import { composerMode, contactName, groupTimelineByDay, waWindowRemainingMs, windowText } from "../../../src/lib/inbox-logic";
import type { TimelineItem } from "../../../src/lib/inbox-types";
import { startCall, useVoice } from "../../../src/lib/voice";

type Row = { key: string; kind: "day"; label: string } | { key: string; kind: "item"; item: TimelineItem };

/** Re-render every 30s so the 24-hour window countdown stays honest. */
function useNow(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export default function ConversationScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const router = useRouter();
  const qc = useQueryClient();
  const user = useUser();
  const now = useNow(30_000);

  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, staleTime: 60_000 });
  const conv = useQuery({ queryKey: inboxKeys.conversation(id), queryFn: () => inboxApi.conversation(id), refetchInterval: POLL_MS });
  const timeline = useQuery({ queryKey: inboxKeys.timeline(id), queryFn: () => inboxApi.timeline(id), refetchInterval: POLL_MS });
  const canCallOut = useVoice((s) => s.canCall && s.status === "ready");
  const [assignOpen, setAssignOpen] = useState(false);

  const caps = me.data?.capabilities ?? user.capabilities;
  const can = (c: string): boolean => caps.includes(c);

  // Opening the chat (and any new inbound while it's open) clears the unread count.
  const unread = conv.data?.unreadCount ?? 0;
  useEffect(() => {
    if (unread > 0) {
      inboxApi
        .markRead(id)
        .then(() => qc.invalidateQueries({ queryKey: inboxKeys.lists }))
        .catch(() => undefined);
    }
  }, [id, unread, qc]);

  const refresh = (): void => {
    void qc.invalidateQueries({ queryKey: inboxKeys.timeline(id) });
    void qc.invalidateQueries({ queryKey: inboxKeys.conversation(id) });
    void qc.invalidateQueries({ queryKey: inboxKeys.lists });
  };

  const patch = useMutation({
    mutationFn: (body: Parameters<typeof inboxApi.patchConversation>[1]) => inboxApi.patchConversation(id, body),
    onSuccess: refresh,
    onError: (err) => Alert.alert("Couldn't update", humanizeError(err)),
  });

  const rows = useMemo<Row[]>(() => {
    const days = groupTimelineByDay(timeline.data ?? [], now);
    const out: Row[] = [];
    for (const d of days) {
      out.push({ key: `day-${d.key}`, kind: "day", label: d.label });
      for (const item of d.items) out.push({ key: `${item.kind}-${item.data.id}`, kind: "item", item });
    }
    return out.reverse(); // the list is inverted: newest at the bottom
  }, [timeline.data, now]);

  if (conv.isPending) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  if (conv.isError) {
    return (
      <Centered>
        <Message kind="danger" text={humanizeError(conv.error)} />
      </Centered>
    );
  }

  const c = conv.data;
  const name = contactName(c.customer?.name, c.customer?.phone);
  const remaining = waWindowRemainingMs(c.lastInboundWaAt, now);
  const win = windowText(remaining);
  const channels = c.number?.channels;
  const mode = composerMode({ caps, canUseNumber: c.can_use_number, channels, windowRemainingMs: remaining });
  const mine = c.assigneeId === user.id;
  const phone = c.customer?.phone ?? null;
  const showCall = canCallOut && can("calls.outbound") && channels !== "whatsapp" && !!phone && c.can_use_number;

  const call = async (): Promise<void> => {
    if (!phone) return;
    try {
      await startCall({ to: phone, numberId: c.phoneNumberId, who: name });
    } catch (err) {
      Alert.alert("Couldn't start the call", humanizeError(err));
    }
  };

  const actions = (): void => {
    const opts: { text: string; onPress?: () => void; style?: "cancel" | "destructive" }[] = [];
    if (!mine) opts.push({ text: "Assign to me", onPress: () => patch.mutate({ assignee_id: user.id }) });
    if (can("inbox.assign")) opts.push({ text: "Assign to someone…", onPress: () => setAssignOpen(true) });
    if (c.assigneeId && (mine || can("inbox.assign"))) {
      opts.push({ text: "Unassign", onPress: () => patch.mutate({ assignee_id: null }) });
    }
    if (can("inbox.close")) {
      if (c.status === "closed") opts.push({ text: "Reopen", onPress: () => patch.mutate({ status: "open" }) });
      else opts.push({ text: "Close conversation", style: "destructive", onPress: () => patch.mutate({ status: "closed" }) });
    }
    if (c.customer) opts.push({ text: "View contact", onPress: () => router.push(`/contact/${c.customerId}`) });
    opts.push({ text: "Cancel", style: "cancel" });
    Alert.alert(name, undefined, opts);
  };

  return (
    <SafeAreaView edges={["bottom"]} style={{ flex: 1, backgroundColor: p.bg }}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable onPress={() => c.customer && router.push(`/contact/${c.customerId}`)} accessibilityRole="button">
              <Text style={{ color: p.text, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
                {name}
              </Text>
              <Text style={{ color: p.muted, fontSize: 12 }} numberOfLines={1}>
                {c.number?.label ?? ""} · {c.assignee ? c.assignee.name : "Unassigned"}
                {c.status === "closed" ? " · Closed" : ""}
              </Text>
            </Pressable>
          ),
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 16 }}>
              {showCall ? (
                <Pressable onPress={() => void call()} accessibilityRole="button" accessibilityLabel={`Call ${name}`} hitSlop={10}>
                  <Text style={{ color: p.accent, fontSize: 16 }}>Call</Text>
                </Pressable>
              ) : null}
              <Pressable onPress={actions} accessibilityRole="button" accessibilityLabel="Conversation actions" hitSlop={10}>
                <Text style={{ color: p.accent, fontSize: 16 }}>{patch.isPending ? "…" : "More"}</Text>
              </Pressable>
            </View>
          ),
        }}
      />
      {channels !== "voice" ? (
        <View style={[styles.window, { backgroundColor: win.open ? p.surfaceAlt : p.note }]}>
          <Text style={{ color: win.open ? p.muted : p.text, fontSize: 13 }}>{win.text}</Text>
        </View>
      ) : null}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
        <FlatList
          inverted
          data={rows}
          keyExtractor={(r) => r.key}
          renderItem={({ item }) => (item.kind === "day" ? <DayHeader label={item.label} /> : <TimelineEntry item={item.item} />)}
          contentContainerStyle={{ paddingVertical: 8 }}
          ListEmptyComponent={
            timeline.isPending ? (
              <ActivityIndicator style={{ margin: 24 }} />
            ) : timeline.isError ? (
              <Message kind="danger" text={humanizeError(timeline.error)} />
            ) : (
              <Message text="No messages yet." />
            )
          }
        />
        <Composer conversationId={id} mode={mode} canNote={can("inbox.notes")} onSent={refresh} />
      </KeyboardAvoidingView>
      <AssignSheet
        visible={assignOpen}
        onClose={() => setAssignOpen(false)}
        onPick={(assigneeId) => {
          setAssignOpen(false);
          patch.mutate({ assignee_id: assigneeId });
        }}
      />
    </SafeAreaView>
  );
}

function AssignSheet(props: { visible: boolean; onClose: () => void; onPick: (userId: string) => void }): React.JSX.Element {
  const p = usePalette();
  const staff = useQuery({ queryKey: inboxKeys.staff, queryFn: inboxApi.staff, enabled: props.visible, staleTime: 60_000 });
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
        <View style={[styles.sheetHead, { borderColor: p.border }]}>
          <Text style={{ color: p.text, fontSize: 18, fontWeight: "700" }}>Assign to</Text>
          <Chip label="Close" onPress={props.onClose} />
        </View>
        {staff.isPending ? (
          <ActivityIndicator style={{ marginTop: 24 }} />
        ) : staff.isError ? (
          <Message kind="danger" text={humanizeError(staff.error)} />
        ) : (
          <FlatList
            data={staff.data}
            keyExtractor={(s) => s.id}
            renderItem={({ item }) => (
              <Pressable onPress={() => props.onPick(item.id)} style={[styles.sheetRow, { borderColor: p.border }]}>
                <Text style={{ color: p.text, fontSize: 16 }}>{item.name}</Text>
              </Pressable>
            )}
          />
        )}
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  window: { paddingHorizontal: 12, paddingVertical: 6 },
  sheetHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetRow: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
});
