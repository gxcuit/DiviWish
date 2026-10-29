import { AuthGate } from "@/features/auth/auth-gate";
export default function RegisterPage() { return <AuthGate screen="register" />; }
