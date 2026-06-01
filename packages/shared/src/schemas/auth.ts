import { z } from "zod";
import { ADMIN_ROLES, CAPABILITIES, type Capability } from "../permissions.js";

const RoleEnum = z.enum(ADMIN_ROLES);
const CapabilityEnum = z.enum(CAPABILITIES as unknown as [Capability, ...Capability[]]);

export const PermissionOverridesSchema = z.object({
  granted: z.array(CapabilityEnum).default([]),
  revoked: z.array(CapabilityEnum).default([]),
});
export type PermissionOverridesSchema = z.infer<typeof PermissionOverridesSchema>;

export const LoginRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

const SessionUser = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  role: RoleEnum,
  branch_id: z.string().uuid().nullable(),
  capabilities: z.array(CapabilityEnum),
});

export const LoginResponse = z.object({ data: z.object({ user: SessionUser }) });
export type LoginResponse = z.infer<typeof LoginResponse>;

export const MeResponse = z.object({ data: SessionUser });
export type MeResponse = z.infer<typeof MeResponse>;
