/**
 * Sales reads for the Overview. All three live under /v1/reports and need reports.view,
 * the same permission as the shop's own sales reports (apps/admin owner Analytics).
 */
import { api } from "@admin/lib/api.js";
import type { ChatOrders, RevenueRow, SalesDay } from "./overview-logic.js";

const range = (from: string, to: string) => `from=${from}&to=${to}`;

export const salesKeys = {
  revenue: (from: string, to: string) => ["overview", "sales", "revenue", from, to] as const,
  days: (from: string, to: string) => ["overview", "sales", "days", from, to] as const,
  chat: (from: string, to: string) => ["overview", "sales", "chat", from, to] as const,
};

export const salesApi = {
  revenue: async (from: string, to: string) =>
    (await api<{ data: RevenueRow[] }>(`/reports/revenue?${range(from, to)}`)).data,
  days: async (from: string, to: string) =>
    (await api<{ data: SalesDay[] }>(`/reports/timeseries?${range(from, to)}&interval=day`)).data,
  chat: async (from: string, to: string) =>
    (await api<{ data: ChatOrders }>(`/reports/chat-orders?${range(from, to)}`)).data,
};
