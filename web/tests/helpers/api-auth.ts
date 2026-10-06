import { AuthenticationError } from "../../server/auth-store";

export const TEST_OWNER = "6506b217-6430-4a37-9340-253b6d9e59ab";
export const TEST_ACCESS_TOKEN = "unit-test-access-token";
export async function testAuthenticate(token: string) {
  if (token !== TEST_ACCESS_TOKEN) throw new AuthenticationError("invalid_token");
  return TEST_OWNER;
}
