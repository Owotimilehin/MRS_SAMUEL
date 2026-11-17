import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Button, Centered, Message, usePalette } from "../../../src/components/ui";
import { humanizeError } from "../../../src/lib/api";
import { useCan } from "../../../src/lib/auth";
import { inboxApi, inboxKeys } from "../../../src/lib/inbox-api";
import { contactName, listTime } from "../../../src/lib/inbox-logic";

export default function ContactScreen(): React.JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const p = usePalette();
  const router = useRouter();
  const qc = useQueryClient();
  const can = useCan();
  const contact = useQuery({ queryKey: inboxKeys.contact(id), queryFn: () => inboxApi.contact(id) });
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (contact.data) {
      setName(contact.data.customer.name ?? "");
      setNotes(contact.data.customer.notes ?? "");
    }
  }, [contact.data]);

  const save = useMutation({
    mutationFn: () => inboxApi.patchContact(id, { name: name.trim() || undefined, notes: notes.trim() ? notes : null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: inboxKeys.all });
      Alert.alert("Saved");
    },
    onError: (err) => Alert.alert("Couldn't save", humanizeError(err)),
  });

  if (contact.isPending) {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  if (contact.isError) {
    return (
      <Centered>
        <Message kind="danger" text={humanizeError(contact.error)} />
      </Centered>
    );
  }

  const { customer, conversations } = contact.data;
  const editable = can("inbox.reply");
  const input = [styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }];

  return (
    <ScrollView style={{ backgroundColor: p.bg }} contentContainerStyle={{ padding: 16 }} keyboardShouldPersistTaps="handled">
      <Text style={{ color: p.text, fontSize: 22, fontWeight: "700" }}>{contactName(customer.name, customer.phone)}</Text>
      {customer.phone ? <Text style={{ color: p.muted, marginTop: 2 }} selectable>{customer.phone}</Text> : null}
      {customer.email ? <Text style={{ color: p.muted }} selectable>{customer.email}</Text> : null}

      <Text style={[styles.label, { color: p.muted }]}>Name</Text>
      <TextInput style={input} value={name} onChangeText={setName} editable={editable} maxLength={120} placeholder="Customer name" placeholderTextColor={p.muted} />
      <Text style={[styles.label, { color: p.muted }]}>Notes</Text>
      <TextInput
        style={[input, { minHeight: 90, textAlignVertical: "top" }]}
        value={notes}
        onChangeText={setNotes}
        editable={editable}
        multiline
        maxLength={4000}
        placeholder="Anything the team should know"
        placeholderTextColor={p.muted}
      />
      {editable ? <Button title="Save" onPress={() => save.mutate()} busy={save.isPending} style={{ marginTop: 12 }} /> : null}

      <Text style={[styles.label, { color: p.muted, marginTop: 24 }]}>Conversations</Text>
      {conversations.map((cv) => (
        <Pressable
          key={cv.id}
          onPress={() => router.push(`/conversation/${cv.id}`)}
          style={[styles.conv, { backgroundColor: p.surface, borderColor: p.border }]}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: p.text, fontWeight: "600" }}>{cv.number_label}</Text>
            <Text style={{ color: p.muted, fontSize: 13 }}>
              {cv.status === "closed" ? "Closed" : cv.status === "pending" ? "Pending" : "Open"}
              {cv.labels.length ? ` · ${cv.labels.join(", ")}` : ""}
            </Text>
          </View>
          <Text style={{ color: p.muted, fontSize: 12 }}>{listTime(cv.last_activity_at)}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  label: { fontSize: 13, fontWeight: "600", marginTop: 16, marginBottom: 6 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  conv: { flexDirection: "row", alignItems: "center", padding: 12, borderRadius: 10, borderWidth: 1, marginBottom: 8 },
});
