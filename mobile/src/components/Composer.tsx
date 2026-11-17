/**
 * Reply box: text (inside the 24-hour window), internal notes, attachments
 * (photo or file, uploaded through a presigned PUT), quick replies and
 * WhatsApp templates. When the window is closed only templates can be sent.
 */
import { useQuery } from "@tanstack/react-query";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { humanizeError } from "../lib/api";
import { inboxApi, inboxKeys } from "../lib/inbox-api";
import {
  fillTemplate,
  sendTypeForMime,
  shouldSendTyping,
  templateBodyText,
  templateParamsComplete,
  type ComposerMode,
} from "../lib/inbox-logic";
import type { InboxTemplate } from "../lib/inbox-types";
import { Button, Chip, Message, usePalette } from "./ui";

export function Composer(props: {
  conversationId: string;
  mode: ComposerMode;
  canNote: boolean;
  onSent: () => void;
}): React.JSX.Element {
  const p = usePalette();
  const [text, setText] = useState("");
  const [note, setNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState<"quick" | "template" | null>(null);
  const lastTyping = useRef<number | null>(null);

  const replyAllowed = props.mode.kind === "text";
  const templatesAllowed = props.mode.kind !== "disabled";
  const inputEnabled = note || replyAllowed;

  const run = async (fn: () => Promise<unknown>, clear = true): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      if (clear) setText("");
      props.onSent();
    } catch (err) {
      Alert.alert("Not sent", humanizeError(err));
    } finally {
      setBusy(false);
    }
  };

  const send = (): void => {
    const body = text.trim();
    if (!body) return;
    if (note) void run(() => inboxApi.addNote(props.conversationId, body));
    else void run(() => inboxApi.sendText(props.conversationId, body));
  };

  const onChange = (v: string): void => {
    setText(v);
    const now = Date.now();
    if (!note && replyAllowed && shouldSendTyping(lastTyping.current, now)) {
      lastTyping.current = now;
      inboxApi.typing(props.conversationId).catch(() => undefined);
    }
  };

  const sendFile = async (file: { uri: string; name: string; mimeType: string; size?: number | null }): Promise<void> => {
    const caption = text.trim() || undefined;
    await run(async () => {
      const ticket = await inboxApi.upload(file);
      const type = ticket.kind ?? sendTypeForMime(file.mimeType);
      await inboxApi.sendMedia(props.conversationId, {
        type,
        media_key: ticket.object_key,
        media_token: ticket.media_token,
        mime: file.mimeType,
        filename: type === "document" ? file.name : undefined,
        caption: type === "audio" ? undefined : caption,
      });
    });
  };

  const pickPhoto = async (): Promise<void> => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images", "videos"], quality: 0.8 });
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return;
    const mimeType = a.mimeType ?? (a.type === "video" ? "video/mp4" : "image/jpeg");
    await sendFile({ uri: a.uri, name: a.fileName ?? `photo.${mimeType.split("/")[1] ?? "jpg"}`, mimeType, size: a.fileSize });
  };

  const pickFile = async (): Promise<void> => {
    const res = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false });
    const a = res.canceled ? undefined : res.assets[0];
    if (!a) return;
    await sendFile({ uri: a.uri, name: a.name, mimeType: a.mimeType ?? "application/octet-stream", size: a.size });
  };

  const attach = (): void => {
    Alert.alert("Send a file", undefined, [
      { text: "Photo or video", onPress: () => void pickPhoto() },
      { text: "Document", onPress: () => void pickFile() },
      { text: "Cancel", style: "cancel" },
    ]);
  };

  if (props.mode.kind === "disabled" && !props.canNote) {
    return (
      <View style={[styles.bar, { backgroundColor: p.surface, borderColor: p.border }]}>
        <Message text={props.mode.reason} />
      </View>
    );
  }

  return (
    <View style={[styles.bar, { backgroundColor: p.surface, borderColor: p.border }]}>
      {props.mode.kind !== "text" && !note ? (
        <Text style={{ color: p.muted, fontSize: 13, marginBottom: 6 }}>{props.mode.reason}</Text>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 6 }} keyboardShouldPersistTaps="handled">
        {props.mode.kind !== "disabled" ? <Chip label="Reply" active={!note} onPress={() => setNote(false)} /> : null}
        {props.canNote ? <Chip label="Note" active={note} onPress={() => setNote(true)} /> : null}
        {!note && replyAllowed ? <Chip label="Attach" onPress={attach} /> : null}
        {!note && replyAllowed ? <Chip label="Quick replies" onPress={() => setSheet("quick")} /> : null}
        {!note && templatesAllowed && props.mode.kind !== "disabled" ? (
          <Chip label="Template" onPress={() => setSheet("template")} />
        ) : null}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={[
            styles.input,
            { color: p.text, borderColor: p.border, backgroundColor: note ? p.note : p.bg, opacity: inputEnabled ? 1 : 0.5 },
          ]}
          editable={inputEnabled && !busy}
          multiline
          placeholder={note ? "Internal note (only staff see this)" : inputEnabled ? "Type a reply" : "Free text is off"}
          placeholderTextColor={p.muted}
          value={text}
          onChangeText={onChange}
          maxLength={4096}
        />
        <Button title={note ? "Add" : "Send"} onPress={send} busy={busy} disabled={!inputEnabled || !text.trim()} style={{ marginLeft: 8 }} />
      </View>

      <QuickReplySheet
        visible={sheet === "quick"}
        onClose={() => setSheet(null)}
        onPick={(body) => {
          setText(body);
          setSheet(null);
        }}
      />
      <TemplateSheet
        visible={sheet === "template"}
        onClose={() => setSheet(null)}
        onSend={async (t, params) => {
          setSheet(null);
          await run(() => inboxApi.sendTemplate(props.conversationId, { name: t.name, language: t.language, params }), false);
        }}
      />
    </View>
  );
}

function Sheet(props: { visible: boolean; title: string; onClose: () => void; children: React.ReactNode }): React.JSX.Element {
  const p = usePalette();
  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
        <View style={[styles.sheetHead, { borderColor: p.border }]}>
          <Text style={{ color: p.text, fontSize: 18, fontWeight: "700" }}>{props.title}</Text>
          <Pressable onPress={props.onClose} accessibilityRole="button" hitSlop={12}>
            <Text style={{ color: p.accent, fontSize: 16 }}>Close</Text>
          </Pressable>
        </View>
        {props.children}
      </SafeAreaView>
    </Modal>
  );
}

function QuickReplySheet(props: { visible: boolean; onClose: () => void; onPick: (body: string) => void }): React.JSX.Element {
  const p = usePalette();
  const q = useQuery({ queryKey: inboxKeys.quickReplies, queryFn: inboxApi.quickReplies, enabled: props.visible });
  return (
    <Sheet visible={props.visible} title="Quick replies" onClose={props.onClose}>
      {q.isPending ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : q.isError ? (
        <Message kind="danger" text={humanizeError(q.error)} />
      ) : (
        <FlatList
          data={q.data}
          keyExtractor={(r) => r.id}
          ListEmptyComponent={<Message text="No quick replies yet. An admin can add them in Inbox settings." />}
          renderItem={({ item }) => (
            <Pressable onPress={() => props.onPick(item.body)} style={[styles.sheetRow, { borderColor: p.border }]}>
              <Text style={{ color: p.text, fontWeight: "600" }}>{item.title}</Text>
              <Text style={{ color: p.muted }} numberOfLines={2}>
                {item.body}
              </Text>
            </Pressable>
          )}
        />
      )}
    </Sheet>
  );
}

function TemplateSheet(props: {
  visible: boolean;
  onClose: () => void;
  onSend: (t: InboxTemplate, params: string[]) => Promise<void>;
}): React.JSX.Element {
  const p = usePalette();
  const q = useQuery({ queryKey: inboxKeys.templates, queryFn: inboxApi.templates, enabled: props.visible });
  const [picked, setPicked] = useState<InboxTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const approved = (q.data ?? []).filter((t) => t.status.toUpperCase() === "APPROVED");

  const close = (): void => {
    setPicked(null);
    setParams([]);
    props.onClose();
  };

  return (
    <Sheet visible={props.visible} title={picked ? picked.name : "Templates"} onClose={close}>
      {picked ? (
        <ScrollView contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
          <Text style={{ color: p.muted, marginBottom: 6 }}>Preview</Text>
          <Text style={[styles.preview, { color: p.text, backgroundColor: p.bubbleOut }]}>
            {fillTemplate(templateBodyText(picked.components) ?? "", params)}
          </Text>
          {Array.from({ length: picked.param_count }, (_, i) => (
            <TextInput
              key={i}
              style={[styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface, marginTop: 10, flex: 0 }]}
              placeholder={`Value for {{${i + 1}}}`}
              placeholderTextColor={p.muted}
              value={params[i] ?? ""}
              onChangeText={(v) =>
                setParams((prev) => {
                  const next = [...prev];
                  next[i] = v;
                  return next;
                })
              }
            />
          ))}
          <Button
            title="Send template"
            style={{ marginTop: 16 }}
            disabled={!templateParamsComplete(params, picked.param_count)}
            onPress={() => {
              const t = picked;
              const values = params.slice(0, t.param_count).map((v) => v.trim());
              setPicked(null);
              setParams([]);
              void props.onSend(t, values);
            }}
          />
          <Button title="Back" kind="secondary" style={{ marginTop: 8 }} onPress={() => setPicked(null)} />
        </ScrollView>
      ) : q.isPending ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : q.isError ? (
        <Message kind="danger" text={humanizeError(q.error)} />
      ) : (
        <FlatList
          data={approved}
          keyExtractor={(t) => t.id}
          ListEmptyComponent={<Message text="No approved templates. An admin can sync them from WhatsApp in Inbox settings." />}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => {
                setPicked(item);
                setParams(Array.from({ length: item.param_count }, () => ""));
              }}
              style={[styles.sheetRow, { borderColor: p.border }]}
            >
              <Text style={{ color: p.text, fontWeight: "600" }}>
                {item.name} <Text style={{ color: p.muted, fontWeight: "400" }}>({item.language})</Text>
              </Text>
              <Text style={{ color: p.muted }} numberOfLines={3}>
                {templateBodyText(item.components) ?? ""}
              </Text>
            </Pressable>
          )}
        />
      )}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingTop: 8, paddingBottom: 8 },
  inputRow: { flexDirection: "row", alignItems: "flex-end" },
  input: { flex: 1, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16, maxHeight: 140 },
  sheetHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetRow: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth },
  preview: { padding: 12, borderRadius: 10, fontSize: 16 },
});
