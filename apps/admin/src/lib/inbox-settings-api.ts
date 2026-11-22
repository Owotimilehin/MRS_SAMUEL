/** Calls for /v1/inbox/settings and /v1/inbox/reports. */
import { api } from "./api.js";
import type { GreetingContentType } from "./inbox-logic.js";
import type {
  HolidayRow,
  HoursProfileRow,
  InboxReport,
  IvrMenuRow,
  PhoneNumberRow,
  TeamWithMembers,
} from "./inbox-types.js";

const S = "/inbox/settings";
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const settingsKeys = {
  numbers: ["inbox", "settings", "numbers"] as const,
  /** Phone lines plus Facebook Page and Instagram accounts (Staff access). */
  numbersAll: ["inbox", "settings", "numbers", "all"] as const,
  teams: ["inbox", "settings", "teams"] as const,
  access: ["inbox", "settings", "access"] as const,
  hours: ["inbox", "settings", "hours"] as const,
  replyTarget: ["inbox", "settings", "reply-target"] as const,
  ivr: ["inbox", "settings", "ivr"] as const,
  users: ["inbox", "settings", "admin-users"] as const,
};

export interface NumberInput {
  e164: string;
  label: string;
  channels: "voice" | "whatsapp" | "both";
  waba_id: string | null;
  wa_phone_number_id: string | null;
  wa_fallback_number_id: string | null;
  voice_provider: string | null;
  inbound_match: string | null;
  max_concurrent_calls: number | null;
  default_team_id: string | null;
  hours_profile_id: string | null;
  ivr_menu_id: string | null;
  after_hours_text: string | null;
  /** Uploaded recording callers hear after hours; null = read the text out. */
  after_hours_audio_key: string | null;
  is_active: boolean;
}

export interface MenuInput {
  name: string;
  greeting_text: string;
  /** Uploaded greeting recording; null = read `greeting_text` out. */
  greeting_audio_key: string | null;
  options: Array<{
    digit: string;
    label: string;
    action: "ring_team" | "voicemail" | "play";
    team_id: string | null;
    play_text: string | null;
    /** Uploaded recording for action "play"; null = read `play_text` out. */
    audio_key: string | null;
  }>;
}

export interface AdminUserLite {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
  /** Extra or removed permissions on top of the role (sent by /admin/users). */
  permissionOverrides?: { granted?: string[]; revoked?: string[] } | null;
}

export const settingsApi = {
  /** Phone lines; with `all`, also the Facebook Page and Instagram accounts (for Staff access). */
  /** Reply-time target in minutes (suite spec 15); null = off. */
  replyTarget: async () => (await api<{ data: { minutes: number | null } }>(`${S}/reply-target`)).data.minutes,
  setReplyTarget: async (minutes: number | null) =>
    (await api<{ data: { minutes: number | null } }>(`${S}/reply-target`, json("PUT", { minutes }))).data.minutes,
  numbers: async (opts: { all?: boolean } = {}) =>
    (await api<{ data: PhoneNumberRow[] }>(`${S}/numbers${opts.all ? "?kind=all" : ""}`)).data,
  createNumber: (b: NumberInput) => api(`${S}/numbers`, json("POST", b)),
  updateNumber: (id: string, b: Partial<NumberInput>) => api(`${S}/numbers/${id}`, json("PATCH", b)),
  registerNumber: (id: string, pin: string) => api(`${S}/numbers/${id}/register`, json("POST", { pin })),
  refreshNumber: (id: string) => api(`${S}/numbers/${id}/refresh`, { method: "POST" }),

  teams: async () => (await api<{ data: TeamWithMembers[] }>(`${S}/teams`)).data,
  createTeam: (b: { name: string; description: string | null }) => api(`${S}/teams`, json("POST", b)),
  updateTeam: (id: string, b: { name?: string; description?: string | null; is_active?: boolean }) =>
    api(`${S}/teams/${id}`, json("PATCH", b)),
  setMembers: (id: string, members: Array<{ user_id: string; is_lead: boolean }>) =>
    api(`${S}/teams/${id}/members`, json("PUT", { members })),

  access: async () => (await api<{ data: Array<{ user_id: string; phone_number_id: string }> }>(`${S}/access`)).data,
  setAccess: (userId: string, numberIds: string[]) => api(`${S}/access/${userId}`, json("PUT", { number_ids: numberIds })),
  adminUsers: async () => (await api<{ data: AdminUserLite[] }>("/admin/users")).data,

  hours: async () => (await api<{ data: { profiles: HoursProfileRow[]; holidays: HolidayRow[] } }>(`${S}/hours`)).data,
  createHours: (b: { name: string; rules: Array<{ weekday: number; open_time: string; close_time: string }> }) =>
    api(`${S}/hours`, json("POST", b)),
  updateHours: (id: string, b: { name: string; rules: Array<{ weekday: number; open_time: string; close_time: string }> }) =>
    api(`${S}/hours/${id}`, json("PUT", b)),
  addHoliday: (b: { date: string; label: string; profile_id: string | null }) => api(`${S}/holidays`, json("POST", b)),
  deleteHoliday: (id: string) => api(`${S}/holidays/${id}`, { method: "DELETE" }),

  ivr: async () => (await api<{ data: IvrMenuRow[] }>(`${S}/ivr`)).data,
  createIvr: (b: MenuInput) => api(`${S}/ivr`, json("POST", b)),
  updateIvr: (id: string, b: MenuInput) => api(`${S}/ivr/${id}`, json("PUT", b)),

  /**
   * Presign, then PUT a greeting recording (MP3/WAV, max 5 MB) straight to
   * storage. Returns the key to save on a menu, option or number.
   */
  uploadGreeting: async (file: File, contentType: GreetingContentType): Promise<string> => {
    const res = await api<{ data: { upload_url: string; object_key: string } }>(
      `${S}/greetings/upload`,
      json("POST", { filename: file.name, content_type: contentType, size_bytes: file.size }),
    );
    const put = await fetch(res.data.upload_url, { method: "PUT", body: file, headers: { "content-type": contentType } });
    if (!put.ok) throw new Error("The recording didn't upload. Check your connection and try again.");
    return res.data.object_key;
  },
  /** Short-lived link to listen to an uploaded greeting. */
  greetingUrl: async (key: string) =>
    (await api<{ data: { url: string } }>(`${S}/greetings/url?key=${encodeURIComponent(key)}`)).data.url,

  report: async (p: { from: string; to: string; number?: string }) => {
    const sp = new URLSearchParams({ from: p.from, to: p.to });
    if (p.number) sp.set("number", p.number);
    return (await api<{ data: InboxReport }>(`/inbox/reports?${sp.toString()}`)).data;
  },
};
