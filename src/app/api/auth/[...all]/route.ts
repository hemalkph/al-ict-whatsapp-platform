import { toNextJsHandler } from "better-auth/next-js";
import { handleAuthRequest } from "@/modules/auth";

// Mounts ONLY the public Better Auth instance (sign-up disabled, user-mutation/reset paths closed). The private
// provisioning instance is not exported from "@/modules/auth" and cannot be imported from src/app (ESLint), so it
// can never be reachable through this route. `handleAuthRequest` creates the instance lazily on first request.
export const { GET, POST, PATCH, PUT, DELETE } = toNextJsHandler(handleAuthRequest);
