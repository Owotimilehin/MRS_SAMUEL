/** Calls for /v1/inbox/settings and /v1/inbox/reports. */
import { api } from "./api.js";
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
  teams: ["inbox", "settings", "teams"] as const,
  access: ["inbox", "settings", "access"] as const,
  hours: ["inbox", "settings", "hours"] as const,
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
  is_active: boolean;
}

export interface MenuInput {
  name: string;
  greeting_text: string;
  options: Array<{
    digit: string;
    label: string;
    action: "ring_team" | "voicemail" | "play";
    team_id: string | null;
    play_text: string | null;
  }>;
}

export interface AdminUserLite {
  id: string;
  email: string;
  name: string | null;
  role: string;
  isActive: boolean;
}

export const settingsApi = {
  numbers: async () => (await api<{ data: PhoneNumberRow[] }>(`${S}/numbers`)).data,
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

  report: async (p: { from: string; to: string; number?: string }) => {
    const sp = new URLSearchParams({ from: p.from, to: p.to });
    if (p.number) sp.set("number", p.number);
    return (await api<{ data: InboxReport }>(`/inbox/reports?${sp.toString()}`)).data;
  },
};
