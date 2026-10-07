export class AuthenticationError extends Error {}
export type AuthenticatedIdentity = { ownerUserId: string; expiresAt: number; tokenFingerprint: string };
export type Authenticate = (token: string) => Promise<string | AuthenticatedIdentity>;
