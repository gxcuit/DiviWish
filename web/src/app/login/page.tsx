import { AuthGate } from "@/features/auth/auth-gate";
export default function LoginPage() { return <AuthGate screen="login" />; }
