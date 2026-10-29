import { AuthGate } from "@/features/auth/auth-gate";
export default function ResetPasswordPage() { return <AuthGate screen="reset" />; }
