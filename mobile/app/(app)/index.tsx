import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Badge, Centered, Chip, Message, usePalette } from "../../src/components/ui";
import { humanizeError } from "../../src/lib/api";
import { POLL_MS } from "../../src/lib/config";
import { inboxApi, inboxKeys, type ConversationFilters } from "../../src/lib/inbox-api";
import { contactName, inboxTabsFor, listTime, type InboxTabKey } from "../../src/lib/inbox-logic";
import type { ConversationRow } from "../../src/lib/inbox-types";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function InboxScreen(): React.JSX.Element {
  const p = usePalette();
  const router = useRouter();
  const me = useQuery({ queryKey: inboxKeys.me, queryFn: inboxApi.me, staleTime: 60_000 });
  const [tab, setTab] = useState<InboxTabKey>("mine");
  const [closed, setClosed] = useState(false);
  const [numberId, setNumberId] = useState<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 400);

  const tabs = useMemo(() => (me.data ? inboxTabsFor(me.data.capabilities, me.data.team_ids) : []), [me.data]);
  const filters: ConversationFilters = { status: closed ? "closed" : "open", view: tab, number: numberId, q: q || undefined };

  const list = useInfiniteQuery({
    queryKey: inboxKeys.list(filters),
    queryFn: ({ pageParam }) => inboxApi.conversations(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next_before ?? undefined,
    refetchInterval: POLL_MS,
    enabled: me.isSuccess,
  });
  const rows = useMemo(() => list.data?.pages.flatMap((pg) => pg.data) ?? [], [list.data]);

  const header = (
    <Stack.Screen
      options={{
        title: "Inbox",
        headerRight: () => (
          <Pressable accessibilityRole="button" onPress={() => router.push("/settings")} hitSlop={12}>
            <Text style={{ color: p.accent, fontSize: 16 }}>Settings</Text>
          </Pressable>
        ),
      }}
    />
  );

  if (me.isPending) {
    return (
      <Centered>
        {header}
        <ActivityIndicator />
      </Centered>
    );
  }
  if (me.isError) {
    return (
      <Centered>
        {header}
        <Message kind="danger" text={humanizeError(me.error)} />
        <Chip label="Try again" onPress={() => void me.refetch()} />
      </Centered>
    );
  }

  const numbers = me.data.numbers;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      {header}
      <View style={[styles.tabs, { borderColor: p.border, backgroundColor: p.surface }]}>
        {tabs.map((t) => (
          <Pressable
            key={t.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.key }}
            onPress={() => setTab(t.key)}
            style={[styles.tab, tab === t.key && { borderBottomColor: p.accent }]}
          >
            <Text style={{ color: tab === t.key ? p.accent : p.muted, fontWeight: "600" }}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      <View style={{ padding: 12, paddingBottom: 4 }}>
        <TextInput
          style={[styles.search, { color: p.text, borderColor: p.border, backgroundColor: p.surface }]}
          placeholder="Search name or phone"
          placeholderTextColor={p.muted}
          value={search}
          onChangeText={setSearch}
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
        />
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        <Chip label={closed ? "Closed" : "Open"} active={closed} onPress={() => setClosed((c) => !c)} />
        {numbers.length > 1 ? (
          <>
            <Chip label="All numbers" active={!numberId} onPress={() => setNumberId(undefined)} />
            {numbers.map((n) => (
              <Chip key={n.id} label={n.label} active={numberId === n.id} onPress={() => setNumberId(n.id)} />
            ))}
          </>
        ) : null}
      </ScrollView>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item }) => <Row row={item} onPress={() => router.push(`/conversation/${item.id}`)} />}
        ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.border, marginLeft: 16 }} />}
        refreshControl={<RefreshControl refreshing={list.isRefetching && !list.isFetchingNextPage} onRefresh={() => void list.refetch()} />}
        onEndReached={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) void list.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        ListEmptyComponent={
          list.isPending ? (
            <ActivityIndicator style={{ marginTop: 32 }} />
          ) : list.isError ? (
            <Message kind="danger" text={humanizeError(list.error)} />
          ) : (
            <Message text={q ? "No conversations match that search." : "Nothing here right now."} />
          )
        }
        ListFooterComponent={list.isFetchingNextPage ? <ActivityIndicator style={{ margin: 16 }} /> : null}
      />
    </View>
  );
}

function Row({ row, onPress }: { row: ConversationRow; onPress: () => void }): React.JSX.Element {
  const p = usePalette();
  const unread = row.unread > 0;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, { backgroundColor: pressed ? p.surfaceAlt : p.surface }]}>
      <View style={{ flex: 1, marginRight: 8 }}>
        <View style={styles.rowTop}>
          <Text style={[styles.name, { color: p.text, fontWeight: unread ? "700" : "600" }]} numberOfLines={1}>
            {contactName(row.customer_name, row.customer_phone)}
          </Text>
          <Text style={{ color: unread ? p.accent : p.muted, fontSize: 12 }}>{listTime(row.last_activity_at)}</Text>
        </View>
        <Text style={{ color: unread ? p.text : p.muted, marginTop: 2 }} numberOfLines={1}>
          {row.preview ?? ""}
        </Text>
        <Text style={{ color: p.muted, fontSize: 12, marginTop: 4 }} numberOfLines={1}>
          {row.number_label}
          {row.assignee_name ? ` · ${row.assignee_name}` : " · Unassigned"}
          {row.status === "pending" ? " · Pending" : ""}
        </Text>
      </View>
      <Badge count={row.unread} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  tabs: { flexDirection: "row", borderBottomWidth: StyleSheet.hairlineWidth },
  tab: { flex: 1, alignItems: "center", paddingVertical: 12, borderBottomWidth: 2, borderBottomColor: "transparent" },
  search: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16 },
  filters: { paddingHorizontal: 12, paddingVertical: 8 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 12 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  name: { fontSize: 16, flex: 1, marginRight: 8 },
});
