/**
 * Plain wording for the Forms tab (suite spec 07, 7.2): the pill, the line and the buttons for each state
 * of a form, what the form asks for, and the secure-connection wording. No React here, so every rule has
 * a test.
 */
import { flowDef, type FlowState, type TemplateTone } from "@ms/shared";
import type { FlowDto, FlowValidationError, InboxFlow, KeySignature } from "./flows-api.js";

export const FORM_STATES: readonly FlowState[] = [
  "not_created",
  "draft_invalid",
  "draft_ready",
  "live",
  "live_update_waiting",
  "blocked",
  "throttled",
  "retired",
];

const PILLS: Record<FlowState, { label: string; tone: TemplateTone }> = {
  not_created: { label: "Not at WhatsApp yet", tone: "grey" },
  draft_invalid: { label: "Draft with errors", tone: "red" },
  draft_ready: { label: "Draft", tone: "amber" },
  live: { label: "Live", tone: "green" },
  live_update_waiting: { label: "Live, update waiting", tone: "amber" },
  blocked: { label: "Blocked by WhatsApp", tone: "red" },
  throttled: { label: "Limited by WhatsApp", tone: "amber" },
  retired: { label: "Retired", tone: "grey" },
};

const LINES: Record<Exclude<FlowState, "draft_invalid">, string> = {
  not_created: "Create it to preview and test.",
  draft_ready: "Ready to test. Publish it to use it with customers.",
  live: "Staff can send this form in chats.",
  live_update_waiting: "A newer version of this form is ready.",
  blocked: "WhatsApp has stopped this form because our server was failing. It cannot be sent.",
  throttled: "Only 10 can be sent an hour until our server is healthy again.",
  retired: "No longer sent. Forms already sent can no longer be opened.",
};

/** The pill and the line under it. `errorCount` is only used by a draft with errors. */
export function formStateWording(state: FlowState, errorCount = 0): { label: string; tone: TemplateTone; line: string } {
  const pill = PILLS[state];
  // A state this screen does not know (a newer server): say nothing wrong, offer nothing.
  if (!pill) return { label: "Unknown", tone: "grey", line: "" };
  if (state === "draft_invalid") {
    const n = Math.max(errorCount, 1);
    return { ...pill, line: `WhatsApp found ${n} problem${n === 1 ? "" : "s"} in this form. The technical lead needs to fix them.` };
  }
  return { ...pill, line: LINES[state] };
}

export type FormAction = "create" | "preview" | "publish" | "upload" | "upload_new" | "retire" | "delete_draft" | "new_copy";

export const FORM_ACTION_LABEL: Record<FormAction, string> = {
  create: "Create at WhatsApp",
  preview: "Preview",
  publish: "Publish",
  upload: "Upload again",
  upload_new: "Upload new version",
  retire: "Retire",
  delete_draft: "Delete draft",
  new_copy: "Create a new copy",
};

/** The buttons a card shows, in order (the table in 7.2). */
export function formActions(form: Pick<FlowDto, "state" | "code_is_newer">): FormAction[] {
  switch (form.state) {
    case "not_created":
      return ["create"];
    case "draft_invalid":
      return ["upload", "delete_draft"];
    case "draft_ready":
      return form.code_is_newer ? ["preview", "publish", "upload", "delete_draft"] : ["preview", "publish", "delete_draft"];
    case "live":
      return ["preview", "retire"];
    case "live_update_waiting":
      return ["preview", "upload_new", "retire"];
    case "blocked":
    case "throttled":
      return ["preview"];
    case "retired":
      return ["new_copy"];
    default:
      return [];
  }
}

/** Each problem WhatsApp found, as a sentence. One that came without words still gets a line. */
export function validationMessages(errors: readonly FlowValidationError[]): string[] {
  return errors.map((e) => {
    const text = (e.message ?? "").trim() || (e.error ?? "").trim();
    return text || "A problem WhatsApp did not describe.";
  });
}

/** "Asks for: Receiver, Phone, …" from the registry's field labels; null for a form the registry does not hold. */
export function asksFor(key: string): string | null {
  const labels = (flowDef(key)?.fields ?? []).map((f) => f.label);
  return labels.length > 0 ? `Asks for: ${labels.join(", ")}` : null;
}

/** The account label is shown only when the list covers more than one WhatsApp account. */
export function showAccountLabels(forms: readonly Pick<FlowDto, "account">[]): boolean {
  return new Set(forms.map((f) => f.account.waba_id)).size > 1;
}

/** "Version N" when it is not the first version, or when another card on the same account is the same form. */
export function versionLabel(form: Pick<FlowDto, "key" | "version" | "account">, forms: readonly Pick<FlowDto, "key" | "account">[]): string | null {
  if (form.version === null) return null;
  const twins = forms.filter((f) => f.key === form.key && f.account.waba_id === form.account.waba_id).length;
  return form.version > 1 || twins > 1 ? `Version ${form.version}` : null;
}

/** A stable name for a card: a form that is not at WhatsApp yet has no id. */
export function cardId(form: Pick<FlowDto, "id" | "key" | "account">): string {
  return form.id ?? `new:${form.account.waba_id}:${form.key}`;
}

/** The secure-connection row for one number (7.2). */
export function keyStatusWording(signature: KeySignature): { label: string; tone: TemplateTone } {
  if (signature === "VALID") return { label: "In place", tone: "green" };
  if (signature === "MISMATCH") return { label: "Needs sending again", tone: "red" };
  return { label: "Not sent yet", tone: "grey" };
}

/** The card shows when the key is set up on the server or the list holds a Phase B form. */
export function showSecureCard(keyConfigured: boolean, forms: readonly Pick<FlowDto, "phase">[]): boolean {
  return keyConfigured || forms.some((f) => f.phase === "B");
}

/** Only a preview link that is a real https address is opened. */
export function safePreviewUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * The "Which form?" choices in the template editor (spec 5.5a item 4): the live forms, plus the one
 * already chosen even when it is no longer live, marked "(not live)".
 */
export function formButtonChoices(forms: readonly Pick<InboxFlow, "key" | "title" | "live">[], chosen: string): { key: string; label: string }[] {
  const out = forms.filter((f) => f.live).map((f) => ({ key: f.key, label: f.title }));
  if (chosen !== "" && !out.some((o) => o.key === chosen)) {
    const title = forms.find((f) => f.key === chosen)?.title ?? flowDef(chosen)?.title ?? chosen;
    out.push({ key: chosen, label: `${title} (not live)` });
  }
  return out;
}
