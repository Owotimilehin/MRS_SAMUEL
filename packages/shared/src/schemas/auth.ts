import { z } from "zod";

export const LoginRequest = z.object({
  email: z.string().email().max(254),
  password: z.string().min(10).max(200)
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const LoginResponse = z.object({
  data: z.object({
    user: z.object({
      id: z.string().uuid(),
      email: z.string().email(),
      role: z.enum(["owner", "factory_dispatcher", "branch_manager", "branch_staff"]),
      branch_id: z.string().uuid().nullable()
    })
  })
});
export type LoginResponse = z.infer<typeof LoginResponse>;
