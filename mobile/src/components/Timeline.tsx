/**
 * Conversation timeline pieces: message bubbles (with ticks / failed state and
 * media), call cards (recording playback, transcript and AI summary when the
 * person may see them) and internal notes.
 */
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { humanizeError } from "../lib/api";
import { inboxApi } from "../lib/inbox-api";
import { callOutcomeLabel, formatDuration, mediaKind, messageTicks, timeOfDay } from "../lib/inbox-logic";
import type { TimelineCall, TimelineItem, TimelineMessage, TimelineNote, TimelineRecording } from "../lib/inbox-types";
import { usePalette } from "./ui";

export function TimelineEntry({ item }: { item: TimelineItem }): React.JSX.Element {
  switch (item.kind) {
    case "message":
      return <MessageBubble m={item.data} />;
    case "call":
      return <CallCard call={item.data} />;
    case "note":
      return <NoteCard note={item.data} />;
  }
}

export function DayHeader({ label }: { label: string }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={styles.dayWrap}>
      <Text style={[styles.day, { color: p.muted, backgroundColor: p.surfaceAlt }]}>{label}</Text>
    </View>
  );
}

function MessageBubble({ m }: { m: TimelineMessage }): React.JSX.Element {
  const p = usePalette();
  const out = m.direction === "out";
  const ticks = out ? messageTicks(m.status) : null;
  const failed = m.status === "failed";
  return (
    <View style={[styles.bubbleRow, { justifyContent: out ? "flex-end" : "flex-start" }]}>
      <View
        style={[
          styles.bubble,
          { backgroundColor: out ? p.bubbleOut : p.bubbleIn, borderColor: failed ? p.danger : p.border },
        ]}
      >
        {out && m.sender_name ? <Text style={[styles.meta, { color: p.muted }]}>{m.sender_name}</Text> : null}
        {m.template_name ? <Text style={[styles.meta, { color: p.muted }]}>Template: {m.template_name}</Text> : null}
        {m.has_media || m.media_pending ? <MediaView m={m} /> : null}
        {m.body ? <Text style={{ color: p.text, fontSize: 16 }}>{m.body}</Text> : null}
        <View style={styles.footer}>
          <Text style={[styles.time, { color: p.muted }]}>{timeOfDay(m.created_at)}</Text>
          {ticks && ticks.marks ? (
            <Text
              accessibilityLabel={ticks.label}
              style={[styles.time, { marginLeft: 4, color: failed ? p.danger : ticks.read ? p.read : p.muted, fontWeight: "700" }]}
            >
              {ticks.marks}
            </Text>
          ) : null}
        </View>
        {failed ? (
          <Text style={{ color: p.danger, fontSize: 13, marginTop: 2 }}>Not sent{m.error_message ? `: ${m.error_message}` : ""}</Text>
        ) : null}
      </View>
    </View>
  );
}

function MediaView({ m }: { m: TimelineMessage }): React.JSX.Element {
  const p = usePalette();
  const kind = mediaKind(m.type, m.media_mime);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (m.media_pending) return <Text style={{ color: p.muted, fontStyle: "italic" }}>Downloading attachment…</Text>;

  const load = async (): Promise<void> => {
    setBusy(true);
    setErr(null);
    try {
      const res = await inboxApi.mediaUrl(m.id);
      if (kind === "image") setUrl(res.url);
      else await Linking.openURL(res.url);
    } catch (e) {
      setErr(humanizeError(e));
    } finally {
      setBusy(false);
    }
  };

  if (kind === "image" && url) {
    return <Image source={{ uri: url }} style={styles.image} resizeMode="cover" accessibilityLabel="Photo" />;
  }
  const label =
    kind === "image" ? "Show photo" : kind === "audio" ? "Play voice note" : kind === "video" ? "Play video" : (m.media_filename ?? "Open file");
  return (
    <View style={{ marginBottom: 4 }}>
      <Pressable onPress={() => void load()} style={[styles.mediaBtn, { borderColor: p.border }]} accessibilityRole="button">
        {busy ? <ActivityIndicator /> : <Text style={{ color: p.accent, fontWeight: "600" }}>{label}</Text>}
      </Pressable>
      {err ? <Text style={{ color: p.danger, fontSize: 12 }}>{err}</Text> : null}
    </View>
  );
}

function CallCard({ call }: { call: TimelineCall }): React.JSX.Element {
  const p = usePalette();
  const missed = call.outcome === "missed" || call.outcome === "failed";
  const title = `${call.direction === "in" ? "Incoming" : "Outgoing"} call · ${callOutcomeLabel(call.outcome, call.direction)}`;
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: missed ? p.danger : p.border }]}>
      <Text style={{ color: missed ? p.danger : p.text, fontWeight: "600" }}>{title}</Text>
      <Text style={{ color: p.muted, fontSize: 13, marginTop: 2 }}>
        {timeOfDay(call.started_at)}
        {call.duration_s ? ` · ${formatDuration(call.duration_s)}` : ""}
        {call.answered_by ? ` · ${call.answered_by}` : ""}
        {call.ivr_choice ? ` · Menu ${call.ivr_choice}` : ""}
      </Text>
      {call.recordings.map((r) => (
        <RecordingView key={r.id} rec={r} />
      ))}
    </View>
  );
}

function RecordingView({ rec }: { rec: TimelineRecording }): React.JSX.Element {
  const p = usePalette();
  const [showTranscript, setShowTranscript] = useState(false);
  const label = rec.kind === "voicemail" ? "Voicemail" : "Recording";
  return (
    <View style={{ marginTop: 8 }}>
      {rec.playable ? (
        <RecordingPlayer recordingId={rec.id} label={`${label} · ${formatDuration(rec.duration_s)}`} />
      ) : (
        <Text style={{ color: p.muted, fontSize: 13 }}>
          {label}
          {rec.status === "pending" ? " · still processing" : rec.status === "failed" ? " · couldn't be saved" : ""}
        </Text>
      )}
      {rec.summary ? (
        <View style={{ marginTop: 6 }}>
          <Text style={{ color: p.text, fontWeight: "600" }}>Summary</Text>
          <Text style={{ color: p.text }}>{rec.summary.summary}</Text>
          {rec.summary.action_items.length ? (
            <Text style={{ color: p.muted, marginTop: 2 }}>To do: {rec.summary.action_items.join("; ")}</Text>
          ) : null}
        </View>
      ) : null}
      {rec.transcript ? (
        <Pressable onPress={() => setShowTranscript((s) => !s)} accessibilityRole="button">
          <Text style={{ color: p.accent, marginTop: 6 }}>{showTranscript ? "Hide transcript" : "Show transcript"}</Text>
          {showTranscript ? <Text style={{ color: p.text, marginTop: 4 }}>{rec.transcript}</Text> : null}
        </Pressable>
      ) : null}
    </View>
  );
}

/** Fetches a short-lived signed link (GET /recordings/:id/url) only when Play is first pressed. */
function RecordingPlayer({ recordingId, label }: { recordingId: string; label: string }): React.JSX.Element {
  const p = usePalette();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async (): Promise<void> => {
    setErr(null);
    if (status.playing) {
      player.pause();
      return;
    }
    if (!loaded) {
      setBusy(true);
      try {
        const url = await inboxApi.recordingUrl(recordingId);
        player.replace({ uri: url });
        setLoaded(true);
      } catch (e) {
        setErr(humanizeError(e));
        setBusy(false);
        return;
      }
      setBusy(false);
    } else if (status.didJustFinish || (status.duration > 0 && status.currentTime >= status.duration)) {
      await player.seekTo(0);
    }
    player.play();
  };

  const progress = loaded && status.duration > 0 ? ` · ${formatDuration(status.currentTime)} / ${formatDuration(status.duration)}` : "";
  return (
    <View>
      <Pressable onPress={() => void toggle()} style={[styles.mediaBtn, { borderColor: p.border }]} accessibilityRole="button">
        {busy ? (
          <ActivityIndicator />
        ) : (
          <Text style={{ color: p.accent, fontWeight: "600" }}>
            {status.playing ? "Pause" : "Play"} {label}
            {progress}
          </Text>
        )}
      </Pressable>
      {err ? <Text style={{ color: p.danger, fontSize: 12 }}>{err}</Text> : null}
    </View>
  );
}

function NoteCard({ note }: { note: TimelineNote }): React.JSX.Element {
  const p = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: p.note, borderColor: p.border }]}>
      <Text style={{ color: p.muted, fontSize: 12, fontWeight: "600" }}>
        Internal note{note.author_name ? ` · ${note.author_name}` : ""} · {timeOfDay(note.created_at)}
      </Text>
      <Text style={{ color: p.text, marginTop: 2 }}>{note.body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  dayWrap: { alignItems: "center", marginVertical: 10 },
  day: { fontSize: 12, paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, overflow: "hidden" },
  bubbleRow: { flexDirection: "row", paddingHorizontal: 12, marginVertical: 3 },
  bubble: { maxWidth: "82%", borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 10, paddingVertical: 6 },
  meta: { fontSize: 12, marginBottom: 2 },
  footer: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", marginTop: 2 },
  time: { fontSize: 11 },
  image: { width: 220, height: 220, borderRadius: 8, marginBottom: 4 },
  mediaBtn: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, marginBottom: 4, alignSelf: "flex-start" },
  card: { marginHorizontal: 12, marginVertical: 4, padding: 10, borderRadius: 12, borderWidth: 1 },
});
