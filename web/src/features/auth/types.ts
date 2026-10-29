export type Account = { id: string; email: string | null; created_at: number; hasPassword: boolean; linuxdoUsername: string | null };
export type AuthConfig = { turnstileSiteKey: string | null; linuxdoEnabled: boolean; emailMode: "console" | "resend" };
