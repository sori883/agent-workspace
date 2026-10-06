export class AuthenticationError extends Error {}
export type Authenticate = (token: string) => Promise<string>;
