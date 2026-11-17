import { Redirect } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Button, Centered, usePalette } from "../src/components/ui";
import { humanizeError } from "../src/lib/api";
import { useAuth } from "../src/lib/auth";

export default function LoginScreen(): React.JSX.Element {
  const p = usePalette();
  const { state, signIn } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.kind === "loading") {
    return (
      <Centered>
        <ActivityIndicator />
      </Centered>
    );
  }
  if (state.kind === "ready") return <Redirect href="/" />;

  const submit = async (): Promise<void> => {
    setError(null);
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    try {
      await signIn(email, password);
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = [styles.input, { color: p.text, borderColor: p.border, backgroundColor: p.surface }];
  const message = error ?? state.reason ?? null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.wrap}>
        <View style={styles.form}>
          <Text style={[styles.title, { color: p.text }]}>MS Staff</Text>
          <Text style={{ color: p.muted, marginBottom: 24 }}>Sign in with your Mrs Samuel admin account.</Text>
          <TextInput
            style={inputStyle}
            placeholder="Email"
            placeholderTextColor={p.muted}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
          />
          <TextInput
            style={inputStyle}
            placeholder="Password"
            placeholderTextColor={p.muted}
            secureTextEntry
            autoComplete="password"
            textContentType="password"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => void submit()}
          />
          {message ? <Text style={{ color: p.danger, marginBottom: 12 }}>{message}</Text> : null}
          <Button title="Sign in" onPress={() => void submit()} busy={busy} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, justifyContent: "center" },
  form: { paddingHorizontal: 24 },
  title: { fontSize: 28, fontWeight: "700", marginBottom: 4 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16, marginBottom: 12 },
});
